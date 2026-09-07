# Idempotency in Payment Systems

A Bun application demonstrating **idempotent payments** under concurrent,
multi-threaded load — a TypeScript port of the classic Java
`ConcurrentHashMap` + `CompletableFuture` single-flight pattern.

## The pattern

Every transfer request carries an **idempotency key** (`requestId`). The
service guarantees:

1. **Execute-once** — N concurrent requests with the same key cause exactly
   one bank call (`doTransfer`); all callers await the *same* in-flight
   computation and receive the identical `TransferResult`.
2. **Replay from cache** — a repeated request with the same key (within the
   TTL) returns the original response without re-executing.
3. **Failure cleanup** — if the transfer fails, the cache entry is removed
   (identity-checked, like `map.remove(key, newEntry)`), so a retry can
   genuinely re-execute.
4. **TTL expiry + eviction** — expired entries are replaced on access and
   swept periodically by a background job (an `unref`'d `setInterval`, the
   equivalent of the daemon eviction thread).
5. **Fingerprint check** — reusing a live key with a *different* request body
   is rejected with `FingerprintMismatchError` (HTTP **422**) instead of
   silently returning the original response.

### Java -> Bun mapping

| Java                              | Bun / TypeScript                              |
| --------------------------------- | --------------------------------------------- |
| `ConcurrentHashMap.compute()`     | `Map` + synchronous check-and-set (atomic on the single-threaded event loop) |
| `CompletableFuture`              | `Promise` with captured `resolve`/`reject`    |
| `future.get(30, SECONDS)`        | `Promise.race([promise, timeout])`            |
| `ScheduledExecutorService` (daemon) | `setInterval(...).unref()`                  |
| `Clock`                          | injectable `() => epochMillis`                |
| `actual == newEntry`             | `actual === newEntry` (reference identity)    |
| `doTransfer()` (the bank call)   | injectable `transferFn` option — stub it in tests, plug in a real processor in prod |

## Run it

```sh
bun install

# Terminal 1: start the server
bun run start

# Terminal 2: fire 6 worker threads x 5 calls = 30 concurrent
# requests with the SAME idempotency key
bun run client
```

Expected output from the client:

```
=== Wave 1: 30 concurrent requests, same key ===
responses received : 30
unique transfer ids: 1 <single-transfer-id>
server executions : 1 (should be 1)
coalesced by key  : 29

=== Wave 2: same key after completion (cache hit) ===
server executions : 0 (should be 0 - cached)

=== Wave 3: different key (new payment) ===
server executions : 1 (should be 1)

All checks passed: idempotency works under concurrent multi-threaded load.
```

## HTTP API

| Method | Path                   | Description                                  |
| ------ | ---------------------- | -------------------------------------------- |
| POST   | `/payments/:requestId` | Idempotent transfer; `requestId` is the idempotency key |
| GET    | `/payments/:requestId` | Inspect the cached entry for that key        |
| GET    | `/stats`               | Counters: requests, executed, coalesced, rejected, failures, evictions |
| GET    | `/health`              | Liveness probe                               |
| GET    | `/docs`                | Interactive OpenAPI docs (Swagger UI)        |
| GET    | `/openapi.json`        | Raw OpenAPI 3.0 specification                |

```sh
curl -X POST http://localhost:3000/payments/order-123 \
  -H "Content-Type: application/json" \
  -d '{"fromAccount":"alice","toAccount":"bob","amount":42.50}'
```

Reusing `order-123` with a different amount returns `422`:

```json
{ "error": "Idempotency key \"order-123\" was already used with a different request body" }
```

Interactive API documentation is served at **`/docs`** (Swagger UI rendering
`/openapi.json`; UI assets load from the unpkg CDN, so viewing docs needs
internet access).

## Tests

```sh
bun test
```

The suite covers the five core guarantees:

1. **Exactly once under concurrency** — 100 concurrent `transfer()` calls
   with the same key invoke `doTransfer` exactly once; all 100 receive the
   same `transferId`.
2. **Consistent response on retry** — same key returns the same
   `TransferResult`; `doTransfer` called once total.
3. **TTL expiry triggers reprocessing** — after advancing the clock past the
   TTL, the same key re-executes and returns a new `transferId`.
4. **Failed transfer is removable** — a throwing `doTransfer` removes the
   entry so a retry re-executes.
5. **Fingerprint mismatch rejected** — same key with a different amount
   throws `FingerprintMismatchError`; over HTTP it maps to `422`.
6. **OpenAPI docs** — `GET /docs` serves Swagger UI and `GET /openapi.json`
   serves the 3.0.3 spec with all endpoints.

## Files

- `src/PaymentService.ts` — the idempotency engine (the ported Java class)
- `src/server.ts` — `Bun.serve()` HTTP API (`startServer()` factory + main entry)
- `src/openapi.ts` — OpenAPI 3.0 specification served at `/openapi.json`
- `src/client.ts` + `src/client-worker.ts` — multi-threaded demo client
- `src/PaymentService.test.ts` — the six-test suite
