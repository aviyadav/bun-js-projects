import { test, expect, describe } from "bun:test";
import {
  PaymentService,
  FingerprintMismatchError,
  type TransferRequest,
  type TransferResult,
} from "./PaymentService";
import { startServer } from "./server";

const requestA: TransferRequest = { fromAccount: "alice", toAccount: "bob", amount: 100 };
const requestB: TransferRequest = { fromAccount: "alice", toAccount: "bob", amount: 250 };

/** A counting, stubbed bank call: records every invocation. */
function makeCountingBank(latencyMs = 10) {
  const calls: TransferRequest[] = [];
  const transferFn = async (request: TransferRequest): Promise<TransferResult> => {
    calls.push(request);
    await Bun.sleep(latencyMs);
    return {
      transferId: `tx-${calls.length}`,
      request,
      processedAt: new Date().toISOString(),
    };
  };
  return { transferFn, calls };
}

describe("idempotent transfer service", () => {
  // Test 1 — exactly once under concurrency
  test("100 threads call transfer() with the same key simultaneously: doTransfer runs exactly once, all get the same transferId", async () => {
    const bank = makeCountingBank(25);
    const svc = new PaymentService({ ttlMs: 60_000, transferFn: bank.transferFn });

    const results = await Promise.all(
      Array.from({ length: 100 }, () => svc.transfer("key-concurrent", requestA)),
    );

    expect(bank.calls.length).toBe(1); // the actual bank call ran exactly once
    expect(svc.stats.executed).toBe(1);
    expect(svc.stats.coalesced).toBe(99);

    const ids = new Set(results.map((r) => r.transferId));
    expect(ids.size).toBe(1); // all 100 threads received the same transferId
    expect(results.every((r) => r.transferId === results[0]!.transferId)).toBe(true);

    svc.shutdown();
  });

  // Test 2 — consistent response on retry
  test("retry with the same key returns the same TransferResult and does not re-execute", async () => {
    const bank = makeCountingBank();
    const svc = new PaymentService({ ttlMs: 60_000, transferFn: bank.transferFn });

    const first = await svc.transfer("key-retry", requestA);
    const second = await svc.transfer("key-retry", requestA);

    expect(second).toBe(first); // same cached TransferResult object
    expect(second.transferId).toBe(first.transferId);
    expect(bank.calls.length).toBe(1); // doTransfer called exactly once total
    expect(svc.stats.executed).toBe(1);

    svc.shutdown();
  });

  // Test 3 — TTL expiry triggers reprocessing
  test("after the TTL the same key is reprocessed and yields a new transferId", async () => {
    let now = Date.now();
    const bank = makeCountingBank();
    const svc = new PaymentService({
      ttlMs: 24 * 60 * 60 * 1000, // 24 hours
      clock: () => now,
      transferFn: bank.transferFn,
    });

    const first = await svc.transfer("key-ttl", requestA);
    expect(bank.calls.length).toBe(1);

    now += 25 * 60 * 60 * 1000; // advance clock by 25 hours
    const second = await svc.transfer("key-ttl", requestA);

    expect(bank.calls.length).toBe(2); // doTransfer called a second time
    expect(second.transferId).not.toBe(first.transferId); // new transferId

    svc.shutdown();
  });

  // Test 4 — failed transfer is removable
  test("a failed doTransfer removes the entry so a retry re-executes", async () => {
    let attempts = 0;
    const transferFn = async (request: TransferRequest): Promise<TransferResult> => {
      attempts++;
      if (attempts === 1) throw new Error("bank unavailable");
      return {
        transferId: "tx-retry-ok",
        request,
        processedAt: new Date().toISOString(),
      };
    };
    const svc = new PaymentService({ ttlMs: 60_000, transferFn });

    const first = await svc.transfer("key-fail", requestA).then(
      (r) => r,
      (e) => e,
    );
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toBe("bank unavailable");
    expect(svc.peek("key-fail")).toBeNull(); // entry was removed

    const retry = await svc.transfer("key-fail", requestA);
    expect(attempts).toBe(2); // doTransfer called again
    expect(retry.transferId).toBe("tx-retry-ok");

    svc.shutdown();
  });

  // Test 5 — fingerprint mismatch rejected
  test("reusing a key with a different request body is rejected (unit + HTTP 422)", async () => {
    // Unit level: FingerprintMismatchError
    const bank = makeCountingBank();
    const svc = new PaymentService({ ttlMs: 60_000, transferFn: bank.transferFn });

    const ok = await svc.transfer("key-mismatch", requestA);
    expect(ok.transferId).toBe("tx-1");

    const err = await svc.transfer("key-mismatch", requestB).then(
      (r) => r,
      (e) => e,
    );
    expect(err).toBeInstanceOf(FingerprintMismatchError);
    expect(bank.calls.length).toBe(1); // the second body never reached the bank
    expect(svc.stats.rejected).toBe(1);

    svc.shutdown();

    // HTTP level: the server maps the mismatch to 422
    const httpService = new PaymentService({ ttlMs: 60_000, paymentLatencyMs: 5 });
    const { server } = startServer({ port: 0, service: httpService });
    const base = `http://localhost:${server.port}`;

    const post = (body: TransferRequest) =>
      fetch(`${base}/payments/key-http`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const first = await post(requestA);
    expect(first.status).toBe(200);
    const second = await post(requestB);
    expect(second.status).toBe(422);
    expect(((await second.json()) as { error: string }).error).toContain(
      "different request body",
    );

    server.stop(true);
    httpService.shutdown();
  });

  // Test 6 — OpenAPI docs are available at /docs
  test("GET /docs serves Swagger UI and GET /openapi.json serves the spec", async () => {
    const { server, service } = startServer({
      port: 0,
      service: new PaymentService({ ttlMs: 60_000, paymentLatencyMs: 5 }),
    });
    const base = `http://localhost:${server.port}`;

    const docs = await fetch(`${base}/docs`);
    expect(docs.status).toBe(200);
    expect(docs.headers.get("content-type")).toContain("text/html");
    const html = await docs.text();
    expect(html).toContain("swagger-ui"); // Swagger UI page referencing /openapi.json
    expect(html).toContain("openapi.json");

    const specRes = await fetch(`${base}/openapi.json`);
    expect(specRes.status).toBe(200);
    const spec = (await specRes.json()) as {
      openapi: string;
      paths: Record<string, unknown>;
      "x-unknown"?: unknown;
    };
    expect(spec.openapi).toBe("3.0.3");
    expect(Object.keys(spec.paths)).toContain("/payments/{requestId}");
    expect(Object.keys(spec.paths)).toContain("/stats");
    expect(Object.keys(spec.paths)).toContain("/health");

    server.stop(true);
    service.shutdown();
  });
});
