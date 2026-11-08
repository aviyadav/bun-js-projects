// Conduit on Hono 4 + Bun (export default { fetch: app.fetch, ...Bun.serve options }), as hono.dev's Bun guide shows.
// One process; cluster.ts starts one per core.
// Local benchmark build: no JWT. The token is the user id itself (`Authorization: Token <id>`), which is NOT secure.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { sValidator } from "@hono/standard-validator";
import * as db from "./db";
import * as f from "./format";
import * as s from "./schemas";

type Env = { Variables: { viewer: number; token: string } };
const app = new Hono<Env>();

const fail = (c: Context, status: 401 | 403 | 404 | 422 | 500, msg: string) => c.json(f.errors(msg), status);

const tokenFor = (u: { id: unknown }) => String(u.id);

// Authorization: Token <user id>. A missing header is 401 (auth) or viewer 0 (optionalAuth); a bad one is 401.
const auth = (required: boolean): MiddlewareHandler<Env> => async (c, next) => {
  const h = c.req.header("Authorization");
  if (h === undefined) {
    if (required) return fail(c, 401, "unauthorized");
    c.set("viewer", 0);
    return next();
  }
  if (!h.startsWith("Token ")) return fail(c, 401, "unauthorized");
  const token = h.slice(6);
  const viewer = f.viewerFromSub(token);
  if (viewer === 0) return fail(c, 401, "unauthorized");
  c.set("viewer", viewer);
  c.set("token", token);
  return next();
};
const requireAuth = auth(true);
const optionalAuth = auth(false);

// Validation failures are 422 with the Conduit error shape (the validator's default is 400).
const valid = <T extends Parameters<typeof sValidator>[1]>(target: "json" | "query", schema: T) =>
  sValidator(target, schema, (result, c) => {
    if (!result.success) return c.json(f.errors("invalid request"), 422);
  });

// ---------- users ----------

app.post("/api/users", valid("json", s.register), async (c) => {
  const { user } = c.req.valid("json");
  if (f.tooLong(user.password)) return fail(c, 422, "password is too long");
  const hash = await f.hashPassword(user.password);
  let u;
  try { u = await db.insertUser(user.username, user.email, hash); } catch (e) {
    if (db.isUniqueViolation(e)) return fail(c, 422, "username or email is already taken");
    throw e;
  }
  return c.json({ user: f.user(u, tokenFor(u)) }, 201);
});

app.post("/api/users/login", valid("json", s.login), async (c) => {
  const { user } = c.req.valid("json");
  const u = await db.userByEmail(user.email);
  if (!u || !(await f.verifyPassword(user.password, u.password_hash))) return fail(c, 401, "invalid email or password");
  return c.json({ user: f.user(u, tokenFor(u)) });
});

app.get("/api/user", requireAuth, async (c) => {
  const u = await db.userById(c.var.viewer);
  if (!u) return fail(c, 401, "unauthorized");
  return c.json({ user: f.user(u, c.var.token) });
});

app.put("/api/user", requireAuth, valid("json", s.updateUser), async (c) => {
  const { user: b } = c.req.valid("json");
  if (b.password != null && f.tooLong(b.password)) return fail(c, 422, "password is too long");
  const hash = b.password == null ? null : await f.hashPassword(b.password);
  let u;
  try {
    u = await db.updateUser(c.var.viewer, b.email ?? null, b.username ?? null, hash, b.bio ?? null, b.image ?? null);
  } catch (e) {
    if (db.isUniqueViolation(e)) return fail(c, 422, "username or email is already taken");
    throw e;
  }
  if (!u) return fail(c, 401, "unauthorized");
  return c.json({ user: f.user(u, c.var.token) });
});

// ---------- profiles ----------

app.get("/api/profiles/:username", optionalAuth, async (c) => {
  const p = await db.profile(c.var.viewer, c.req.param("username"));
  if (!p) return fail(c, 404, "profile not found");
  return c.json({ profile: f.profile(p) });
});

app.post("/api/profiles/:username/follow", requireAuth, async (c) => {
  const u = await db.userByUsername(c.req.param("username"));
  if (!u) return fail(c, 404, "profile not found");
  await db.follow(c.var.viewer, u.id);
  return c.json({ profile: f.profile(u, true) });
});

app.delete("/api/profiles/:username/follow", requireAuth, async (c) => {
  const u = await db.userByUsername(c.req.param("username"));
  if (!u) return fail(c, 404, "profile not found");
  await db.unfollow(c.var.viewer, u.id);
  return c.json({ profile: f.profile(u, false) });
});

// ---------- articles ----------

app.get("/api/articles", optionalAuth, valid("query", s.listQuery), async (c) => {
  const q = c.req.valid("query");
  const v = c.var.viewer;
  let rows, count;
  if (q.tag) { rows = await db.listByTag(v, q.limit, q.offset, q.tag); count = await db.countByTag(q.tag); }
  else if (q.author) { rows = await db.listByAuthor(v, q.limit, q.offset, q.author); count = await db.countByAuthor(q.author); }
  else if (q.favorited) { rows = await db.listByFavorited(v, q.limit, q.offset, q.favorited); count = await db.countByFavorited(q.favorited); }
  else { rows = await db.listArticles(v, q.limit, q.offset); count = await db.countArticles(); }
  return c.json({ articles: rows.map((r: any) => f.article(r, false)), articlesCount: count });
});

app.get("/api/articles/feed", requireAuth, valid("query", s.feedQuery), async (c) => {
  const q = c.req.valid("query");
  const rows = await db.feed(c.var.viewer, q.limit, q.offset);
  const count = await db.countFeed(c.var.viewer);
  return c.json({ articles: rows.map((r: any) => f.article(r, false)), articlesCount: count });
});

app.post("/api/articles", requireAuth, valid("json", s.createArticle), async (c) => {
  const { article: b } = c.req.valid("json");
  const id = await db.createArticle(c.var.viewer, b.title, b.description, b.body, b.tagList ?? []);
  return c.json({ article: f.article(await db.articleById(c.var.viewer, id), true) }, 201);
});

app.get("/api/articles/:slug", optionalAuth, async (c) => {
  const row = await db.articleBySlug(c.var.viewer, c.req.param("slug"));
  if (!row) return fail(c, 404, "article not found");
  return c.json({ article: f.article(row, true) });
});

app.put("/api/articles/:slug", requireAuth, valid("json", s.updateArticle), async (c) => {
  const { article: b } = c.req.valid("json");
  const a = await db.articleOwner(c.req.param("slug"));
  if (!a) return fail(c, 404, "article not found");
  if (Number(a.author_id) !== c.var.viewer) return fail(c, 403, "forbidden");
  await db.updateArticle(a.id, b.title ?? null, b.description ?? null, b.body ?? null);
  return c.json({ article: f.article(await db.articleById(c.var.viewer, a.id), true) });
});

app.delete("/api/articles/:slug", requireAuth, async (c) => {
  const a = await db.articleOwner(c.req.param("slug"));
  if (!a) return fail(c, 404, "article not found");
  if (Number(a.author_id) !== c.var.viewer) return fail(c, 403, "forbidden");
  await db.deleteArticle(a.id);
  return c.body(null, 204);
});

// ---------- favorites ----------

app.post("/api/articles/:slug/favorite", requireAuth, async (c) => {
  const id = await db.articleId(c.req.param("slug"));
  if (!id) return fail(c, 404, "article not found");
  await db.favorite(c.var.viewer, id);
  return c.json({ article: f.article(await db.articleById(c.var.viewer, id), true) });
});

app.delete("/api/articles/:slug/favorite", requireAuth, async (c) => {
  const id = await db.articleId(c.req.param("slug"));
  if (!id) return fail(c, 404, "article not found");
  await db.unfavorite(c.var.viewer, id);
  return c.json({ article: f.article(await db.articleById(c.var.viewer, id), true) });
});

// ---------- comments ----------

app.get("/api/articles/:slug/comments", optionalAuth, async (c) => {
  const id = await db.articleId(c.req.param("slug"));
  if (!id) return fail(c, 404, "article not found");
  const rows = await db.comments(c.var.viewer, id);
  return c.json({ comments: rows.map((r: any) => f.comment(r)) });
});

app.post("/api/articles/:slug/comments", requireAuth, valid("json", s.createComment), async (c) => {
  const { comment } = c.req.valid("json");
  const id = await db.articleId(c.req.param("slug"));
  if (!id) return fail(c, 404, "article not found");
  return c.json({ comment: f.comment(await db.insertComment(id, c.var.viewer, comment.body), false) }, 201);
});

app.delete("/api/articles/:slug/comments/:id", requireAuth, async (c) => {
  const cid = c.req.param("id");
  if (!f.isId(cid)) return fail(c, 404, "comment not found");
  const author = await db.commentAuthor(cid, c.req.param("slug"));
  if (author === undefined) return fail(c, 404, "comment not found");
  if (Number(author) !== c.var.viewer) return fail(c, 403, "forbidden");
  await db.deleteComment(cid);
  return c.body(null, 204);
});

// ---------- tags ----------

app.get("/api/tags", async (c) => c.json({ tags: await db.tags() }));

// ---------- errors ----------

app.notFound((c) => fail(c, 404, "not found"));
app.onError((err, c) => {
  // The json validator throws HTTPException(400) for a malformed body: Conduit wants 422.
  if (err instanceof HTTPException && err.status === 400) return fail(c, 422, "invalid request");
  if (err instanceof HTTPException) return c.json(f.errors(err.message), err.status);
  console.error(err);
  return fail(c, 500, "internal error");
});

export default {
  hostname: process.env.HOST || "127.0.0.1",
  port: Number(process.env.PORT) || 3000,
  reusePort: true,
  idleTimeout: 75,
  development: false,
  fetch: app.fetch,
};
