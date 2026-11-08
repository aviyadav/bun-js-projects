// Conduit on Elysia 1.4 (Bun): `t` schemas on every route, auth as macros with `resolve`, errors from onError.
// One process; cluster.ts starts one per core.
// Local benchmark build: no JWT. The token is the user id itself (`Authorization: Token <id>`), which is NOT secure.
import { Elysia, t, status } from "elysia";
import * as db from "./db";
import * as f from "./format";

const nonEmpty = t.String({ minLength: 1 });
const optNonEmpty = t.Optional(t.Nullable(t.String({ minLength: 1 }))); // absent or null: unchanged
const optText = t.Optional(t.Nullable(t.String()));
const digits = t.Optional(t.String({ pattern: "^[0-9]+$" }));

const listQuery = t.Object({
  limit: digits, offset: digits, tag: t.Optional(t.String()), author: t.Optional(t.String()), favorited: t.Optional(t.String()),
});

// Range checks (limit 1..100, offset <= int64 max) on top of the schema's digits-only pattern.
const page = (q: { limit?: string; offset?: string }) => f.page(q.limit, q.offset);

const tokenFor = (u: { id: unknown }) => String(u.id);

const app = new Elysia()
  .onError(({ code, error }) => {
    // Schema failures (Elysia's default is already 422) and unparsable bodies (400) both answer 422 in the
    // Conduit error shape.
    if (code === "VALIDATION" || code === "PARSE") return status(422, f.errors("invalid request"));
    if (code === "NOT_FOUND") return status(404, f.errors("not found"));
    console.error(error);
    return status(500, f.errors("internal error"));
  })
  .macro({
    // Authorization: Token <user id>. A missing header is 401 (auth) or viewer 0 (optionalAuth); a bad one is 401.
    auth: {
      resolve({ headers }) {
        const h = headers.authorization;
        if (h === undefined || !h.startsWith("Token ")) return status(401, f.errors("unauthorized"));
        const token = h.slice(6);
        const viewer = f.viewerFromSub(token);
        if (viewer === 0) return status(401, f.errors("unauthorized"));
        return { viewer, token };
      },
    },
    optionalAuth: {
      resolve({ headers }) {
        const h = headers.authorization;
        if (h === undefined) return { viewer: 0 };
        if (!h.startsWith("Token ")) return status(401, f.errors("unauthorized"));
        const viewer = f.viewerFromSub(h.slice(6));
        if (viewer === 0) return status(401, f.errors("unauthorized"));
        return { viewer };
      },
    },
  })

  // ---------- users ----------

  .post("/api/users", async ({ body: { user } }) => {
    if (f.tooLong(user.password)) return status(422, f.errors("password is too long"));
    const hash = await f.hashPassword(user.password);
    let u;
    try { u = await db.insertUser(user.username, user.email, hash); } catch (e) {
      if (db.isUniqueViolation(e)) return status(422, f.errors("username or email is already taken"));
      throw e;
    }
    return status(201, { user: f.user(u, tokenFor(u)) });
  }, { body: t.Object({ user: t.Object({ username: nonEmpty, email: nonEmpty, password: nonEmpty }) }) })

  .post("/api/users/login", async ({ body: { user } }) => {
    const u = await db.userByEmail(user.email);
    if (!u || !(await f.verifyPassword(user.password, u.password_hash))) return status(401, f.errors("invalid email or password"));
    return { user: f.user(u, tokenFor(u)) };
  }, { body: t.Object({ user: t.Object({ email: nonEmpty, password: nonEmpty }) }) })

  .get("/api/user", async ({ viewer, token }) => {
    const u = await db.userById(viewer);
    if (!u) return status(401, f.errors("unauthorized"));
    return { user: f.user(u, token) };
  }, { auth: true })

  .put("/api/user", async ({ viewer, token, body: { user: b } }) => {
    if (b.password != null && f.tooLong(b.password)) return status(422, f.errors("password is too long"));
    const hash = b.password == null ? null : await f.hashPassword(b.password);
    let u;
    try { u = await db.updateUser(viewer, b.email ?? null, b.username ?? null, hash, b.bio ?? null, b.image ?? null); } catch (e) {
      if (db.isUniqueViolation(e)) return status(422, f.errors("username or email is already taken"));
      throw e;
    }
    if (!u) return status(401, f.errors("unauthorized"));
    return { user: f.user(u, token) };
  }, {
    auth: true,
    body: t.Object({ user: t.Object({ email: optNonEmpty, username: optNonEmpty, password: optNonEmpty, bio: optText, image: optText }) }),
  })

  // ---------- profiles ----------

  .get("/api/profiles/:username", async ({ viewer, params }) => {
    const p = await db.profile(viewer, params.username);
    if (!p) return status(404, f.errors("profile not found"));
    return { profile: f.profile(p) };
  }, { optionalAuth: true })

  .post("/api/profiles/:username/follow", async ({ viewer, params }) => {
    const u = await db.userByUsername(params.username);
    if (!u) return status(404, f.errors("profile not found"));
    await db.follow(viewer, u.id);
    return { profile: f.profile(u, true) };
  }, { auth: true })

  .delete("/api/profiles/:username/follow", async ({ viewer, params }) => {
    const u = await db.userByUsername(params.username);
    if (!u) return status(404, f.errors("profile not found"));
    await db.unfollow(viewer, u.id);
    return { profile: f.profile(u, false) };
  }, { auth: true })

  // ---------- articles ----------

  .get("/api/articles", async ({ viewer, query: q }) => {
    const p = page(q);
    if (!p) return status(422, f.errors("invalid limit or offset"));
    let rows, count;
    if (q.tag) { rows = await db.listByTag(viewer, p.limit, p.offset, q.tag); count = await db.countByTag(q.tag); }
    else if (q.author) { rows = await db.listByAuthor(viewer, p.limit, p.offset, q.author); count = await db.countByAuthor(q.author); }
    else if (q.favorited) { rows = await db.listByFavorited(viewer, p.limit, p.offset, q.favorited); count = await db.countByFavorited(q.favorited); }
    else { rows = await db.listArticles(viewer, p.limit, p.offset); count = await db.countArticles(); }
    return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: count };
  }, { optionalAuth: true, query: listQuery })

  .get("/api/articles/feed", async ({ viewer, query }) => {
    const p = page(query);
    if (!p) return status(422, f.errors("invalid limit or offset"));
    const rows = await db.feed(viewer, p.limit, p.offset);
    return { articles: rows.map((r: any) => f.article(r, false)), articlesCount: await db.countFeed(viewer) };
  }, { auth: true, query: t.Object({ limit: digits, offset: digits }) })

  .post("/api/articles", async ({ viewer, body: { article: b } }) => {
    const id = await db.createArticle(viewer, b.title, b.description, b.body, b.tagList ?? []);
    return status(201, { article: f.article(await db.articleById(viewer, id), true) });
  }, {
    auth: true,
    body: t.Object({
      article: t.Object({
        title: nonEmpty, description: nonEmpty, body: nonEmpty, tagList: t.Optional(t.Nullable(t.Array(nonEmpty))),
      }),
    }),
  })

  .get("/api/articles/:slug", async ({ viewer, params }) => {
    const row = await db.articleBySlug(viewer, params.slug);
    if (!row) return status(404, f.errors("article not found"));
    return { article: f.article(row, true) };
  }, { optionalAuth: true })

  .put("/api/articles/:slug", async ({ viewer, params, body: { article: b } }) => {
    const a = await db.articleOwner(params.slug);
    if (!a) return status(404, f.errors("article not found"));
    if (Number(a.author_id) !== viewer) return status(403, f.errors("forbidden"));
    await db.updateArticle(a.id, b.title ?? null, b.description ?? null, b.body ?? null);
    return { article: f.article(await db.articleById(viewer, a.id), true) };
  }, {
    auth: true,
    body: t.Object({ article: t.Object({ title: optNonEmpty, description: optNonEmpty, body: optNonEmpty }) }),
  })

  .delete("/api/articles/:slug", async ({ viewer, params }) => {
    const a = await db.articleOwner(params.slug);
    if (!a) return status(404, f.errors("article not found"));
    if (Number(a.author_id) !== viewer) return status(403, f.errors("forbidden"));
    await db.deleteArticle(a.id);
    return status(204);
  }, { auth: true })

  // ---------- favorites ----------

  .post("/api/articles/:slug/favorite", async ({ viewer, params }) => {
    const id = await db.articleId(params.slug);
    if (!id) return status(404, f.errors("article not found"));
    await db.favorite(viewer, id);
    return { article: f.article(await db.articleById(viewer, id), true) };
  }, { auth: true })

  .delete("/api/articles/:slug/favorite", async ({ viewer, params }) => {
    const id = await db.articleId(params.slug);
    if (!id) return status(404, f.errors("article not found"));
    await db.unfavorite(viewer, id);
    return { article: f.article(await db.articleById(viewer, id), true) };
  }, { auth: true })

  // ---------- comments ----------

  .get("/api/articles/:slug/comments", async ({ viewer, params }) => {
    const id = await db.articleId(params.slug);
    if (!id) return status(404, f.errors("article not found"));
    const rows = await db.comments(viewer, id);
    return { comments: rows.map((r: any) => f.comment(r)) };
  }, { optionalAuth: true })

  .post("/api/articles/:slug/comments", async ({ viewer, params, body: { comment } }) => {
    const id = await db.articleId(params.slug);
    if (!id) return status(404, f.errors("article not found"));
    return status(201, { comment: f.comment(await db.insertComment(id, viewer, comment.body), false) });
  }, { auth: true, body: t.Object({ comment: t.Object({ body: nonEmpty }) }) })

  .delete("/api/articles/:slug/comments/:id", async ({ viewer, params }) => {
    if (!f.isId(params.id)) return status(404, f.errors("comment not found"));
    const author = await db.commentAuthor(params.id, params.slug);
    if (author === undefined) return status(404, f.errors("comment not found"));
    if (Number(author) !== viewer) return status(403, f.errors("forbidden"));
    await db.deleteComment(params.id);
    return status(204);
  }, { auth: true })

  // ---------- tags ----------

  .get("/api/tags", async () => ({ tags: await db.tags() }))

  .listen({
    hostname: process.env.HOST || "127.0.0.1",
    port: Number(process.env.PORT) || 3000,
    reusePort: true,
    idleTimeout: 75,
    development: false,
  });

export type App = typeof app;
