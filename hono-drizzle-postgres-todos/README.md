# Hono + Drizzle + Postgres Todos

A lightweight Todo API built with Hono, Drizzle ORM, and PostgreSQL on Bun.

## What This Project Does

- Exposes an API endpoint to fetch todos by user ID.
- Stores users and todos in PostgreSQL.
- Uses Drizzle migrations and schema-driven DB tooling.
- Includes test coverage for core todo query behavior.

## Tech Stack

- Runtime: Bun
- Web framework: Hono
- ORM: Drizzle ORM
- Database: PostgreSQL
- Migration tooling: drizzle-kit
- Seed/reset tooling: drizzle-seed + custom scripts

## API

### GET /todos?userId=<uuid>

Returns todos for the provided user ID ordered by newest first.

Error behavior:

- `400` when `userId` is missing
- `500` on internal DB or server errors

## Data Model Summary

- `users`
	- `id` (uuid, primary key)
	- `email` (unique, required)
	- `password_hash` (required)
	- `age` (0 to 120)
	- timestamps (`created_at`, `updated_at`)
- `todos`
	- `id` (uuid, primary key)
	- `user_id` (required, foreign key to users)
	- `title` (required)
	- `description` (optional)
	- `completed` (default false)
	- timestamps (`created_at`, `updated_at`)

## Environment Variables

Create a `.env` file with at least:

```env
DATABASE_URL=postgres://pocuser:password@localhost:5432/pocdb
```

Optional (used by reset script):

```env
ADMIN_DB_URL=postgres://postgres:password@localhost:5432/postgres
```

Optional (recommended for tests):

```env
TEST_DATABASE_URL=postgres://pocuser:password@localhost:5432/pocdb_test
```

## Install And Run

To install dependencies:

```sh
bun install
```

To run:

```sh
bun run dev
```

Open http://localhost:3000

## Database Commands

```sh
bun run db:generate:migration
bun run db:migrate
bun run db:seed
bun run db:studio
bun run db:reset
```

## Test

```sh
bun test
```

## Project Run Chart

The chart below is based on the command flow captured in `run-cmd.txt` and aligned with this repository's scripts.

```mermaid
flowchart TD
	A[Create project with Hono] --> B[Install runtime dependencies<br/>drizzle-orm, pg]
	B --> C[Install dev dependencies<br/>drizzle-kit, types, drizzle-seed]
	C --> D[Configure environment variables]
	D --> E[Generate migrations<br/>bun run db:generate:migration]
	E --> F[Apply migrations<br/>bun run db:migrate]
	F --> G[Seed database<br/>bun run db:seed]
	G --> H[Run tests<br/>bun test]
	H --> I{Need fresh reset?}
	I -- Yes --> J[Reset DB<br/>bun run db:reset]
	J --> K[Start API server<br/>bun run dev]
	I -- No --> K
	K --> L[Explore DB in Studio<br/>bun run db:studio]
	K --> M[Call endpoint<br/>GET /todos?userId=<uuid>]
```

## Helpful Query Examples

Example Drizzle query patterns used in this project:

```ts
db.select().from(todos).limit(10);

db.select()
	.from(todos)
	.where(eq(todos.userId, userId))
	.orderBy(desc(todos.createdAt));

db.insert(todos)
	.values({ userId, title: 'clean the basement', description: 'vacuum and organize toys' })
	.returning();
```
