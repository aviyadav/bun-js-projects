// zod 4 request schemas (identical in the zod-based bun-* stacks: hono, h3, express). Unknown keys are stripped.
import { z } from "zod";

const DIGITS = /^[0-9]+$/;
const INT64_MAX = 9223372036854775807n;

const required = z.string().min(1);
const optionalNonEmpty = z.string().min(1).nullish(); // absent or null: unchanged
const optionalText = z.string().nullish();

export const register = z.object({ user: z.object({ username: required, email: required, password: required }) });
export const login = z.object({ user: z.object({ email: required, password: required }) });
export const updateUser = z.object({
  user: z.object({
    email: optionalNonEmpty, username: optionalNonEmpty, password: optionalNonEmpty, bio: optionalText, image: optionalText,
  }),
});
export const createArticle = z.object({
  article: z.object({ title: required, description: required, body: required, tagList: z.array(required).nullish() }),
});
export const updateArticle = z.object({
  article: z.object({ title: optionalNonEmpty, description: optionalNonEmpty, body: optionalNonEmpty }),
});
export const createComment = z.object({ comment: z.object({ body: required }) });

// limit 1..100 (default 20), offset 0..int64 max (default 0, kept as a decimal string). Digits only: no sign,
// spaces or decimals. Present-but-empty is invalid.
export const listQuery = z.object({
  limit: z.string().regex(DIGITS).transform(Number).pipe(z.number().min(1).max(100)).default(20),
  offset: z.string().refine((s) => DIGITS.test(s) && BigInt(s) <= INT64_MAX).transform((s) => BigInt(s).toString()).default("0"),
  tag: z.string().optional(),
  author: z.string().optional(),
  favorited: z.string().optional(),
});
export const feedQuery = listQuery.pick({ limit: true, offset: true });
