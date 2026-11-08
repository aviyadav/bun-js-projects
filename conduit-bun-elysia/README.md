# conduit-bun-elysia (local)

RealWorld "Conduit" API on Bun + Elysia, taken from
[js-runtimes-benchmark](https://github.com/arjaythedev/js-runtimes-benchmark) (`stacks/bun-elysia`) and changed to
run locally without JWT, Nginx or Go.

- **No JWT.** The token is the user id: `Authorization: Token 42`. Login and sign-up return it as `user.token`.
  Not secure, for benchmarking only.
- **Seed:** `seed/seed.py` (Python) replaces the Go `seedgen`. It uses the same distributions, but the data is not
  byte-identical. Every user's password is `password123`.
- **Load test:** `bench/locustfile.py` (Locust) replaces the Go `loadgen`, with the same page mix as `WORKLOAD.md`.

Needs Bun, [uv](https://docs.astral.sh/uv/) and Postgres. Config is in `.env` (Bun loads it automatically).


create DB
```bash
uv run --with "psycopg[binary]" python -c 'import psycopg; c = psycopg.connect("postgres://conduit_user:password@127.0.0.1:5432/postgres", autocommit=True); c.execute("CREATE DATABASE conduit"); c.close()'

bun run seed

```




```sh
bun install
bun run seed                      # drops/recreates tables: 100k users, 10k articles (~15 s)
uv run seed/seed.py --articles 500000   # optional: benchmark-sized data set (much slower, ~2.4 GB)

bun run start                     # one process on 127.0.0.1:3000
bun run start:cluster             # one process per core (reusePort), what the benchmark runs
```

## API test CLI (curl)

`api/conduit.sh` tests all 19 endpoints (50 checks: status codes plus response contents), or sends a single
request. Sample request bodies are in `api/samples/`. Each test run creates its own users and data, so you can rerun
it as often as you like. Needs `curl` and `python3`.

```sh
bun run api:test                  # or: api/conduit.sh test   (VERBOSE=1 prints bodies, BASE_URL=... to retarget)
api/conduit.sh call GET /api/tags
api/conduit.sh call GET /api/user 5                          # token = user id
api/conduit.sh call POST /api/articles 5 create-article.json  # body from api/samples/
api/conduit.sh call PUT /api/user 5 '{"user":{"bio":"hi"}}'  # or inline JSON
```

## Benchmark

With the server running, in another terminal:

```bash
bun run start:cluster
```


```sh
# web UI at http://localhost:8089
bun run bench

# headless: 2000 users, 200/s spawn rate, 2 minutes, one Locust worker per core
bun run bench -- --headless -u 2000 -r 200 -t 2m --processes -1 

or

bun run bench -- --headless -u 2000 -r 200 -t 2m --processes -1 2>1  2>&1 | tee bench.log

# no think time: maximum throughput
THINK_MEAN=0 bun run bench -- --headless -u 200 -r 50 -t 1m --processes -1
```



Environment knobs: `THINK_MEAN` (seconds, default 1; the original benchmark uses 7), `ARTICLES` (match your
seed's `--articles`, default 10000), `USERS_IN_DB` (default 100000).

Notes:
- The load generator and the server share the CPU on one machine, so watch Locust's CPU warning. Use
  `--processes -1` so Locust doesn't become the bottleneck.
- Pool size is `90 / workers` connections per process (`src/db.ts`). Keep it under Postgres's `max_connections`.
- For thousands of users, raise the open-files limit first (`ulimit -n 65535`).
- `bun run seed` again resets the data between runs.



### cleanup 

As an admin
```SQL
DROP DATABASE IF EXISTS conduit WITH (FORCE)
```
 or

 ```bash
uv run --with "psycopg[binary]" python -c 'import psycopg; c = psycopg.connect("postgres://conduit_user:password@127.0.0.1:5432/postgres", autocommit=True); c.execute("DROP DATABASE IF EXISTS conduit WITH (FORCE)"); c.close()'
```
