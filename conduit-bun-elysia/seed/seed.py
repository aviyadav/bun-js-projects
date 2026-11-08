# /// script
# requires-python = ">=3.11"
# dependencies = ["psycopg[binary]>=3.2"]
# ///
"""Seed the Conduit database (Python stand-in for the benchmark's Go seedgen).

    uv run seed/seed.py                 # dev size: 100k users, 10k articles (~1 min)
    uv run seed/seed.py --articles 500000   # benchmark size (~2.4 GB, takes a while)

Drops and recreates every table from schema.sql, then bulk-loads with COPY. Distributions follow the benchmark's
WORKLOAD.md (Zipf authors/tags, lognormal favorites/comments/follows); the data is random but repeatable (--seed),
not byte-identical to the Go seed. Every user's password is `password123`.
"""

import argparse
import itertools
import math
import os
import random
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import psycopg

# bcrypt (cost 10) of "password123", shared by every seeded user so seeding doesn't spend minutes hashing.
PASSWORD_HASH = "$2b$10$DyQfHJfnk1d4IBvzv8yo..Q02t6RU2Nj3.XXtUDGNspE9HJAU/KUC"

WORDS = (
    "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore "
    "magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo "
    "consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint "
    "occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum javascript bun "
    "node deno server runtime postgres query index cache latency throughput benchmark cluster worker thread async"
).split()

NOW = datetime(2026, 10, 1, tzinfo=timezone.utc)
HISTORY = timedelta(days=730)


def zipf_cum_weights(n: int, s: float) -> list[float]:
    return list(itertools.accumulate(1.0 / (k ** s) for k in range(1, n + 1)))


def lognormal_count(rng: random.Random, mean: float, cap: int, sigma: float = 1.0) -> int:
    mu = math.log(mean) - sigma * sigma / 2
    return min(cap, int(rng.lognormvariate(mu, sigma)))


def slugify(s: str) -> str:
    # Same as the SQL: trim(both '-' from lower(regexp_replace(x, '[^A-Za-z0-9]+', '-', 'g')))
    return re.sub(r"[^A-Za-z0-9]+", "-", s).lower().strip("-")


def sentence(rng: random.Random, n: int) -> str:
    return " ".join(rng.choices(WORDS, k=n))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("DATABASE_URL",
                                                    "postgres://conduit_user:password@127.0.0.1:5432/conduit"))
    ap.add_argument("--users", type=int, default=100_000)
    ap.add_argument("--articles", type=int, default=10_000)
    ap.add_argument("--tags", type=int, default=200)
    ap.add_argument("--seed", type=int, default=42)
    a = ap.parse_args()

    rng = random.Random(a.seed)
    n_users, n_articles, n_tags = a.users, a.articles, a.tags
    n_authors = max(1, int(n_users * 0.3))
    # Authors are a random 30% of users, ranked so a few are prolific (Zipf 0.8).
    authors = rng.sample(range(1, n_users + 1), n_authors)
    author_cw = zipf_cum_weights(n_authors, 0.8)
    tag_cw = zipf_cum_weights(n_tags, 1.0)
    tag_ids = list(range(1, n_tags + 1))
    user_ids = range(1, n_users + 1)

    t0 = time.time()
    with psycopg.connect(a.url) as conn:
        with conn.cursor() as cur:
            print("== schema")
            cur.execute("DROP TABLE IF EXISTS comments, favorites, article_tags, tags, articles, follows, users CASCADE")
            cur.execute((Path(__file__).resolve().parent.parent / "schema.sql").read_text())

            print(f"== tags ({n_tags})")
            with cur.copy("COPY tags (id, name) FROM STDIN") as cp:
                for i in tag_ids:
                    cp.write_row((i, f"{WORDS[i % len(WORDS)]}{i}"))

            print(f"== users ({n_users})")
            with cur.copy("COPY users (id, username, email, password_hash, bio, image, created_at) FROM STDIN") as cp:
                for uid in user_ids:
                    bio = sentence(rng, rng.randint(5, 15)) if rng.random() < 0.5 else None
                    image = f"https://api.realworld.io/images/{uid}.jpg" if rng.random() < 0.3 else None
                    created = NOW - HISTORY - timedelta(days=rng.random() * 365)
                    cp.write_row((uid, f"user{uid}", f"user{uid}@example.com", PASSWORD_HASH, bio, image, created))

            print(f"== articles ({n_articles}) + tags, favorites, comments")
            step = HISTORY / max(1, n_articles)
            counts = {"article_tags": 0, "favorites": 0, "comments": 0}
            art_tags, favs, comments = [], [], []
            with cur.copy("COPY articles (id, slug, author_id, title, description, body, created_at, updated_at) "
                          "FROM STDIN") as cp:
                for aid in range(1, n_articles + 1):
                    created = NOW - HISTORY + step * aid  # id order == creation order
                    title = sentence(rng, rng.randint(3, 8)).title()
                    author = rng.choices(authors, cum_weights=author_cw)[0]
                    body = "\n\n".join(sentence(rng, 40) for _ in range(4))  # ~1 KB
                    cp.write_row((aid, f"{slugify(title)}-{aid}", author, title, sentence(rng, 12), body,
                                  created, created))
                    for t in set(rng.choices(tag_ids, cum_weights=tag_cw, k=rng.randint(1, 4))):
                        art_tags.append((aid, t))
                    for u in rng.sample(user_ids, lognormal_count(rng, 10, 2000)):
                        favs.append((u, aid, created))
                    for _ in range(lognormal_count(rng, 5, 200)):
                        c = created + timedelta(seconds=rng.random() * 30 * 86400)
                        comments.append((aid, rng.randint(1, n_users), sentence(rng, rng.randint(5, 30)), c, c))
            comments.sort(key=lambda r: (r[3], r[0]))  # comment ids in time order
            for table, cols, rows in (("article_tags", "article_id, tag_id", art_tags),
                                      ("favorites", "user_id, article_id, created_at", favs),
                                      ("comments", "article_id, author_id, body, created_at, updated_at", comments)):
                with cur.copy(f"COPY {table} ({cols}) FROM STDIN") as cp:
                    for r in rows:
                        cp.write_row(r)
                counts[table] = len(rows)
            del art_tags, favs, comments

            print("== follows")
            n_follows = 0
            with cur.copy("COPY follows (follower_id, followee_id, created_at) FROM STDIN") as cp:
                for uid in user_ids:
                    k = lognormal_count(rng, 20, 500)
                    for f in set(rng.choices(authors, cum_weights=author_cw, k=k)):
                        if f != uid:
                            cp.write_row((uid, f, NOW - HISTORY))
                            n_follows += 1

            for t in ("users", "articles", "tags", "comments"):
                cur.execute(f"SELECT setval(pg_get_serial_sequence('{t}', 'id'), (SELECT max(id) FROM {t}))")
        conn.commit()
        conn.autocommit = True
        print("== vacuum analyze")
        conn.execute("VACUUM (ANALYZE)")
        size = conn.execute("SELECT pg_size_pretty(pg_database_size(current_database()))").fetchone()[0]

    print(f"done in {time.time() - t0:.0f} s, {size}: {n_users} users, {n_articles} articles, "
          f"{counts['article_tags']} article_tags, {counts['favorites']} favorites, {counts['comments']} comments, "
          f"{n_follows} follows. Password for every user: password123")


if __name__ == "__main__":
    main()
