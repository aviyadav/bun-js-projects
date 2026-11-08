"""Conduit load test, modeled on the benchmark's WORKLOAD.md (page mix, ~5% writes).

    bun run start:cluster                      # server, one process per core
    bun run bench -- --headless -u 2000 -r 200 -t 2m --processes -1

Each Locust user is one browser-like visitor with its own keep-alive connection. Think time is exponential;
the benchmark uses a 7 s mean, which needs tens of thousands of users to stress the server, so the default here is
1 s. Set THINK_MEAN=7 to match the original model, or THINK_MEAN=0 for a no-think throughput test.
Seeded users are user1..user100000 (Token = user id); the seed's article count comes from ARTICLES.
"""

import os
import random

from locust import FastHttpUser, between, task  # noqa: F401  (between kept for quick experiments)

THINK_MEAN = float(os.environ.get("THINK_MEAN", "1"))
N_USERS = int(os.environ.get("USERS_IN_DB", "100000"))
N_ARTICLES = int(os.environ.get("ARTICLES", "10000"))
# Deep links: Zipf(0.9) over recency, precomputed once per process.
_RANKS = range(N_ARTICLES)
_ZIPF = [1.0 / (r + 1) ** 0.9 for r in _RANKS]


class Visitor(FastHttpUser):
    def wait_time(self):
        return min(random.expovariate(1 / THINK_MEAN), THINK_MEAN * 10) if THINK_MEAN > 0 else 0

    def on_start(self):
        self.uid = random.randint(1, N_USERS)
        self.headers = {"Authorization": f"Token {self.uid}"}
        self.list = []  # last article list seen
        self.article = None  # current article
        self.my_slug = None
        self.my_comment = None
        r = random.random()
        if r < 0.75:
            self.get("/api/user", name="/api/user")
        elif r < 0.995:
            # Real login: a bcrypt verify on the server.
            self.client.post("/api/users/login", name="/api/users/login",
                             json={"user": {"email": f"user{self.uid}@example.com", "password": "password123"}})
        else:
            n = f"lg{random.getrandbits(48):x}"
            with self.client.post("/api/users", name="/api/users", catch_response=True,
                                  json={"user": {"username": n, "email": f"{n}@example.com",
                                                 "password": "password123"}}) as res:
                if res.status_code == 201:
                    self.headers = {"Authorization": f"Token {res.json()['user']['token']}"}

    # ---------- helpers ----------

    def get(self, path, name=None):
        return self.client.get(path, headers=self.headers, name=name or path)

    @staticmethod
    def offset(limit):
        return 0 if random.random() < 0.7 else limit * random.randint(1, 4)

    def read_list(self, res):
        if res.status_code == 200:
            arts = res.json().get("articles", [])
            if arts:
                self.list = arts

    def pick_article(self):
        if self.list and random.random() < 0.8:
            return random.choice(self.list)["slug"]
        aid = N_ARTICLES - random.choices(_RANKS, weights=_ZIPF)[0]
        res = self.get(f"/api/articles?limit=1&offset={N_ARTICLES - aid}", name="/api/articles?deeplink")
        if res.status_code == 200 and res.json()["articles"]:
            return res.json()["articles"][0]["slug"]
        return None

    def ensure_article(self):
        if self.article is None:
            self.article_page()
        return self.article

    # ---------- pages (weights from WORKLOAD.md, x10) ----------

    @task(220)
    def home_global(self):
        self.get("/api/tags")
        self.read_list(self.get(f"/api/articles?limit=10&offset={self.offset(10)}", name="/api/articles"))

    @task(150)
    def home_feed(self):
        self.get("/api/tags")
        self.read_list(self.get(f"/api/articles/feed?limit=10&offset={self.offset(10)}", name="/api/articles/feed"))

    @task(80)
    def tag_page(self):
        tags = self.article["tagList"] if self.article and self.article["tagList"] and random.random() < 0.5 else None
        tag = random.choice(tags) if tags else None
        if tag is None:
            res = self.get("/api/tags")
            if res.status_code != 200 or not res.json()["tags"]:
                return
            all_tags = res.json()["tags"]
            tag = all_tags[min(int(random.paretovariate(1)) - 1, len(all_tags) - 1)]
        self.read_list(self.get(f"/api/articles?tag={tag}&limit=10&offset={self.offset(10)}", name="/api/articles?tag"))

    @task(353)
    def article_page(self, slug=None):
        slug = slug or self.pick_article()
        if not slug:
            return
        res = self.get(f"/api/articles/{slug}", name="/api/articles/:slug")
        if res.status_code == 200:
            self.article = res.json()["article"]
        self.get(f"/api/articles/{slug}/comments", name="/api/articles/:slug/comments")

    @task(80)
    def profile_page(self):
        if not self.ensure_article():
            return
        u = self.article["author"]["username"]
        self.get(f"/api/profiles/{u}", name="/api/profiles/:u")
        self.get(f"/api/articles?author={u}&limit=5", name="/api/articles?author")

    @task(20)
    def profile_favorited(self):
        if not self.ensure_article():
            return
        u = self.article["author"]["username"]
        self.get(f"/api/profiles/{u}", name="/api/profiles/:u")
        self.get(f"/api/articles?favorited={u}&limit=5", name="/api/articles?favorited")

    @task(40)
    def favorite_toggle(self):
        if not self.ensure_article():
            return
        a = self.article
        method = self.client.delete if a["favorited"] else self.client.post
        res = method(f"/api/articles/{a['slug']}/favorite", headers=self.headers, name="/api/articles/:slug/favorite")
        if res.status_code == 200:
            self.article = res.json()["article"]

    @task(25)
    def post_comment(self):
        if not self.ensure_article():
            return
        res = self.client.post(f"/api/articles/{self.article['slug']}/comments", headers=self.headers,
                               name="/api/articles/:slug/comments [POST]",
                               json={"comment": {"body": "Nice article, thanks for writing it."}})
        if res.status_code == 201:
            self.my_comment = (self.article["slug"], res.json()["comment"]["id"])

    @task(15)
    def follow_toggle(self):
        if not self.ensure_article():
            return
        author = self.article["author"]
        method = self.client.delete if author["following"] else self.client.post
        res = method(f"/api/profiles/{author['username']}/follow", headers=self.headers,
                     name="/api/profiles/:u/follow")
        if res.status_code == 200:
            author["following"] = res.json()["profile"]["following"]

    @task(8)
    def publish(self):
        res = self.client.post("/api/articles", headers=self.headers, name="/api/articles [POST]",
                               json={"article": {"title": "Load test article", "description": "Written by locust",
                                                 "body": "Hello " * 150, "tagList": ["bench", "locust"]}})
        if res.status_code == 201:
            self.my_slug = res.json()["article"]["slug"]
            self.article_page(self.my_slug)

    @task(3)
    def edit_own(self):
        if not self.my_slug:
            return self.article_page()
        self.get(f"/api/articles/{self.my_slug}", name="/api/articles/:slug")
        res = self.client.put(f"/api/articles/{self.my_slug}", headers=self.headers, name="/api/articles/:slug [PUT]",
                              json={"article": {"description": "Edited by locust"}})
        if res.status_code == 404:
            self.my_slug = None

    @task(3)
    def delete_own_comment(self):
        if not self.my_comment:
            return self.article_page()
        slug, cid = self.my_comment
        self.my_comment = None
        self.client.delete(f"/api/articles/{slug}/comments/{cid}", headers=self.headers,
                           name="/api/articles/:slug/comments/:id")

    @task(3)
    def settings(self):
        self.get("/api/user", name="/api/user")
        self.client.put("/api/user", headers=self.headers, name="/api/user [PUT]",
                        json={"user": {"bio": f"bio {random.random():.6f}"}})
