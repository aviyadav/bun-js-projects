// Response shapes and small helpers shared by every bun-* stack (identical file in each folder).

// Bun.sql returns timestamptz as a Date with millisecond precision (microseconds truncated), so toISOString()
// gives RFC 3339 UTC with exactly 3 fractional digits.
const iso = (d: Date) => d.toISOString();

export function profile(r: any, following: boolean = r.following) {
  return { username: r.username, bio: r.bio, image: r.image, following };
}

export function user(r: any, token: string) {
  return { email: r.email, token, username: r.username, bio: r.bio, image: r.image };
}

export function article(r: any, withBody: boolean) {
  const a: Record<string, unknown> = {
    slug: r.slug,
    title: r.title,
    description: r.description,
    tagList: r.tag_list,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    favorited: r.favorited,
    favoritesCount: Number(r.favorites_count),
    author: profile(r),
  };
  if (withBody) a.body = r.body;
  return a;
}

export function comment(r: any, following: boolean = r.following) {
  return {
    id: Number(r.id),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    body: r.body,
    author: profile(r, following),
  };
}

export const errors = (msg: string) => ({ errors: { body: [msg] } });

const DIGITS = /^[0-9]+$/;
const INT64_MAX = 9223372036854775807n;

// limit: default 20, 1..100; offset: default 0, 0..int64 max. Present-but-invalid (even empty) is null (-> 422).
// offset stays a decimal string so values past 2^53 reach Postgres intact.
export function page(limit: string | null | undefined, offset: string | null | undefined) {
  let l = 20, o = "0";
  if (limit != null) {
    if (!DIGITS.test(limit)) return null;
    l = Number(limit);
    if (l < 1 || l > 100) return null;
  }
  if (offset != null) {
    if (!DIGITS.test(offset) || BigInt(offset) > INT64_MAX) return null;
    o = BigInt(offset).toString();
  }
  return { limit: l, offset: o };
}

// Comment ids in the path: digits that fit in a bigint, otherwise 404.
export const isId = (s: string) => DIGITS.test(s) && BigInt(s) <= INT64_MAX;

// bcrypt only uses the first 72 bytes; Bun.password pre-hashes longer ones with SHA-512, but the contract says
// such passwords are rejected (422), as the reference implementations do.
export const tooLong = (pw: string) => Buffer.byteLength(pw) > 72;

export const hashPassword = (pw: string) => Bun.password.hash(pw, { algorithm: "bcrypt", cost: 10 });
export const verifyPassword = (pw: string, hash: string) => Bun.password.verify(pw, hash);

// JWT subject: a positive decimal user id.
export function viewerFromSub(sub: unknown): number {
  if (typeof sub !== "string" || !/^[1-9][0-9]{0,14}$/.test(sub)) return 0;
  return Number(sub);
}
