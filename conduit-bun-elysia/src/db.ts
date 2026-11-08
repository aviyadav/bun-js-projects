// Postgres access with Bun.sql (Bun's built-in client). The statements are the reference SQL from SPEC.md, with
// `$n` placeholders written as tagged-template parameters (Bun sends them as prepared-statement parameters).
// This file is identical in every bun-* stack.
import { SQL } from "bun";

const workers = Number(process.env.WORKERS) || 1;
export const sql = new SQL(process.env.DATABASE_URL!, { max: Math.floor(90 / workers) });

// int8 columns come back from Bun.sql as strings (its default, `bigint: false`); the JSON needs numbers.
export type Viewer = number;

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof SQL.PostgresError && e.errno === "23505";
}

// ---------- users ----------

export async function insertUser(username: string, email: string, hash: string) {
  const [u] = await sql`INSERT INTO users (username, email, password_hash) VALUES (${username}, ${email}, ${hash})
RETURNING id, username, email, bio, image`;
  return u;
}

export async function userByEmail(email: string) {
  const [u] = await sql`SELECT id, username, email, bio, image, password_hash FROM users WHERE email = ${email}`;
  return u;
}

export async function userById(id: Viewer) {
  const [u] = await sql`SELECT id, username, email, bio, image FROM users WHERE id = ${id}`;
  return u;
}

export async function updateUser(id: Viewer, email: string | null, username: string | null, hash: string | null,
  bio: string | null, image: string | null) {
  const [u] = await sql`UPDATE users SET email = COALESCE(${email}, email), username = COALESCE(${username}, username),
                 password_hash = COALESCE(${hash}, password_hash), bio = COALESCE(${bio}, bio), image = COALESCE(${image}, image)
 WHERE id = ${id}
RETURNING id, username, email, bio, image`;
  return u;
}

// ---------- profiles ----------

export async function profile(viewer: Viewer, username: string) {
  const [p] = await sql`SELECT u.id, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = u.id) AS following
  FROM users u WHERE u.username = ${username}`;
  return p;
}

export async function userByUsername(username: string) {
  const [u] = await sql`SELECT id, username, bio, image FROM users WHERE username = ${username}`;
  return u;
}

export async function follow(viewer: Viewer, followee: string) {
  await sql`INSERT INTO follows (follower_id, followee_id) VALUES (${viewer}, ${followee}) ON CONFLICT DO NOTHING`;
}

export async function unfollow(viewer: Viewer, followee: string) {
  await sql`DELETE FROM follows WHERE follower_id = ${viewer} AND followee_id = ${followee}`;
}

// ---------- article lists ----------

export async function listArticles(viewer: Viewer, limit: number, offset: string) {
  return sql`SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`;
}

export async function countArticles() {
  const [r] = await sql`SELECT count(*) FROM (SELECT 1 FROM articles a LIMIT 1000) s`;
  return Number(r.count);
}

export async function listByTag(viewer: Viewer, limit: number, offset: string, tag: string) {
  return sql`SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.id IN (SELECT at.article_id FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = ${tag}) ORDER BY at.article_id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`;
}

export async function countByTag(tag: string) {
  const [r] = await sql`SELECT count(*) FROM (SELECT 1 FROM article_tags at WHERE at.tag_id = (SELECT t.id FROM tags t WHERE t.name = ${tag}) LIMIT 1000) s`;
  return Number(r.count);
}

export async function listByAuthor(viewer: Viewer, limit: number, offset: string, author: string) {
  return sql`SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.author_id = (SELECT au.id FROM users au WHERE au.username = ${author}) ORDER BY a.id DESC LIMIT ${limit} OFFSET ${offset}`;
}

export async function countByAuthor(author: string) {
  const [r] = await sql`SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id = (SELECT u.id FROM users u WHERE u.username = ${author}) LIMIT 1000) s`;
  return Number(r.count);
}

export async function listByFavorited(viewer: Viewer, limit: number, offset: string, favorited: string) {
  return sql`SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.id IN (SELECT f.article_id FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = ${favorited}) ORDER BY f.article_id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`;
}

export async function countByFavorited(favorited: string) {
  const [r] = await sql`SELECT count(*) FROM (SELECT 1 FROM favorites f WHERE f.user_id = (SELECT fu.id FROM users fu WHERE fu.username = ${favorited}) LIMIT 1000) s`;
  return Number(r.count);
}

export async function feed(viewer: Viewer, limit: number, offset: string) {
  return sql`SELECT a.id, a.slug, a.title, a.description, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.id IN (SELECT x.id FROM follows fo CROSS JOIN LATERAL
    (SELECT a2.id FROM articles a2 WHERE a2.author_id = fo.followee_id ORDER BY a2.id DESC LIMIT (${limit}::int + ${offset}::int)) x
  WHERE fo.follower_id = ${viewer} ORDER BY x.id DESC LIMIT ${limit} OFFSET ${offset}) ORDER BY a.id DESC`;
}

export async function countFeed(viewer: Viewer) {
  const [r] = await sql`SELECT count(*) FROM (SELECT 1 FROM articles a WHERE a.author_id IN (SELECT fo.followee_id FROM follows fo WHERE fo.follower_id = ${viewer}) LIMIT 1000) s`;
  return Number(r.count);
}

// ---------- single articles ----------

export async function articleBySlug(viewer: Viewer, slug: string) {
  const [a] = await sql`SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.slug = ${slug}`;
  return a;
}

export async function articleById(viewer: Viewer, id: string) {
  const [a] = await sql`SELECT a.id, a.slug, a.title, a.description, a.body, a.created_at, a.updated_at,
       ARRAY(SELECT t.name FROM article_tags at JOIN tags t ON t.id = at.tag_id
              WHERE at.article_id = a.id ORDER BY t.name) AS tag_list,
       (SELECT count(*) FROM favorites f WHERE f.article_id = a.id) AS favorites_count,
       EXISTS (SELECT 1 FROM favorites f WHERE f.article_id = a.id AND f.user_id = ${viewer}) AS favorited,
       u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = a.author_id) AS following
  FROM articles a
  JOIN users u ON u.id = a.author_id
 WHERE a.id = ${id}`;
  return a;
}

export async function createArticle(viewer: Viewer, title: string, description: string, body: string, tags: string[]) {
  return sql.begin(async (tx) => {
    const [r] = await tx`INSERT INTO articles (id, slug, author_id, title, description, body)
SELECT n.id, trim(both '-' from lower(regexp_replace(${title}, '[^A-Za-z0-9]+', '-', 'g'))) || '-' || n.id, ${viewer}, ${title}, ${description}, ${body}
  FROM (SELECT nextval(pg_get_serial_sequence('articles', 'id')) AS id) n
RETURNING id`;
    if (tags.length > 0) {
      await tx`INSERT INTO tags (name) SELECT DISTINCT unnest(${tags}::text[]) ON CONFLICT (name) DO NOTHING`;
      await tx`INSERT INTO article_tags (article_id, tag_id) SELECT ${r.id}, t.id FROM tags t WHERE t.name = ANY(${tags}::text[])`;
    }
    return r.id as string;
  });
}

export async function articleOwner(slug: string) {
  const [a] = await sql`SELECT id, author_id FROM articles WHERE slug = ${slug}`;
  return a;
}

export async function updateArticle(id: string, title: string | null, description: string | null, body: string | null) {
  await sql`UPDATE articles SET title = COALESCE(${title}, title), description = COALESCE(${description}, description), body = COALESCE(${body}, body),
       slug = CASE WHEN ${title}::text IS NULL THEN slug ELSE trim(both '-' from lower(regexp_replace(${title}, '[^A-Za-z0-9]+', '-', 'g'))) || '-' || id END,
       updated_at = now()
 WHERE id = ${id}`;
}

export async function deleteArticle(id: string) {
  await sql`DELETE FROM articles WHERE id = ${id}`;
}

// ---------- favorites ----------

export async function articleId(slug: string) {
  const [a] = await sql`SELECT id FROM articles WHERE slug = ${slug}`;
  return a?.id as string | undefined;
}

export async function favorite(viewer: Viewer, id: string) {
  await sql`INSERT INTO favorites (user_id, article_id) VALUES (${viewer}, ${id}) ON CONFLICT DO NOTHING`;
}

export async function unfavorite(viewer: Viewer, id: string) {
  await sql`DELETE FROM favorites WHERE user_id = ${viewer} AND article_id = ${id}`;
}

// ---------- comments ----------

export async function comments(viewer: Viewer, articleId: string) {
  return sql`SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image,
       EXISTS (SELECT 1 FROM follows fo WHERE fo.follower_id = ${viewer} AND fo.followee_id = c.author_id) AS following
  FROM comments c JOIN users u ON u.id = c.author_id
 WHERE c.article_id = ${articleId}
 ORDER BY c.created_at DESC, c.id DESC
 LIMIT 100`;
}

export async function insertComment(articleId: string, viewer: Viewer, body: string) {
  const [c] = await sql`WITH c AS (INSERT INTO comments (article_id, author_id, body) VALUES (${articleId}, ${viewer}, ${body})
           RETURNING id, body, created_at, updated_at, author_id)
SELECT c.id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image
  FROM c JOIN users u ON u.id = c.author_id`;
  return c;
}

export async function commentAuthor(id: string, slug: string) {
  const [c] = await sql`SELECT c.author_id FROM comments c JOIN articles a ON a.id = c.article_id
 WHERE c.id = ${id} AND a.slug = ${slug}`;
  return c?.author_id as string | undefined;
}

export async function deleteComment(id: string) {
  await sql`DELETE FROM comments WHERE id = ${id}`;
}

// ---------- tags ----------

export async function tags() {
  const rows = await sql`SELECT name FROM tags ORDER BY name`;
  return rows.map((r: { name: string }) => r.name);
}
