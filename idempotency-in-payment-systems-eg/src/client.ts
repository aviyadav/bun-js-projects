/**
 * Demo client: hammers the payment server from multiple real worker
 * threads, all using the SAME idempotency key, and verifies that:
 *   1. every caller gets the identical transactionId
 *   2. the server executed the payment exactly once
 *   3. a second wave (same key, after completion) is still served from cache
 *   4. a different key results in a new execution
 */

import type { WorkerResult } from "./client-worker";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const WORKERS = 6; // threads
const CALLS_PER_WORKER = 5; // 30 concurrent requests total
const REQUEST_ID = `order-${crypto.randomUUID().slice(0, 8)}`;

interface Stats {
  requests: number;
  executed: number;
  coalesced: number;
  failures: number;
  evictions: number;
  cacheSize: number;
}

const body = { fromAccount: "alice", toAccount: "bob", amount: 42.5 };

async function stats(): Promise<Stats> {
  const res = await fetch(`${BASE_URL}/stats`);
  return (await res.json()) as Stats;
}

function spawnWave(requestId: string, amount: number): Promise<WorkerResult[]> {
  const workerUrl = new URL("./client-worker.ts", import.meta.url).href;
  return new Promise((resolve) => {
    const results: WorkerResult[] = [];
    for (let i = 0; i < WORKERS; i++) {
      const worker = new Worker(workerUrl);
      worker.onmessage = (e: MessageEvent<WorkerResult>) => {
        results.push(e.data);
        worker.terminate();
        if (results.length === WORKERS) resolve(results);
      };
      worker.postMessage({ url: BASE_URL, requestId, body: { ...body, amount }, calls: CALLS_PER_WORKER, workerId: i });
    }
  });
}

function report(label: string, results: WorkerResult[]) {
  const allIds = results.flatMap((r) => r.transferIds);
  const errors = results.flatMap((r) => r.errors);
  const unique = new Set(allIds);
  console.log(`\n=== ${label} ===`);
  console.log(`responses received : ${allIds.length}`);
  console.log(`errors            : ${errors.length}${errors.length ? " -> " + errors[0] : ""}`);
  console.log(`unique transfer ids: ${unique.size} ${[...unique].map((id) => id.slice(0, 8)).join(", ")}`);
  return { allIds, unique, errors };
}

async function main() {
  console.log(`Firing ${WORKERS} threads x ${CALLS_PER_WORKER} calls, idempotency key: ${REQUEST_ID}`);

  const before = await stats();

  // Wave 1: 30 concurrent duplicate requests
  const wave1 = report("Wave 1: 30 concurrent requests, same key", await spawnWave(REQUEST_ID, 42.5));

  const after = await stats();
  console.log(`server executions : ${after.executed - before.executed} (should be 1)`);
  console.log(`coalesced by key  : ${after.coalesced - before.coalesced}`);

  if (wave1.unique.size !== 1) {
    console.error("FAIL: expected exactly one unique transactionId");
    process.exit(1);
  }
  if (after.executed - before.executed !== 1) {
    console.error("FAIL: expected exactly one execution");
    process.exit(1);
  }

  // Wave 2: same key again after completion - served from cache
  const wave2 = report("Wave 2: same key after completion (cache hit)", await spawnWave(REQUEST_ID, 42.5));
  const after2 = await stats();
  console.log(`server executions : ${after2.executed - after.executed} (should be 0 - cached)`);
  if (wave2.unique.size !== 1 || after2.executed !== after.executed) {
    console.error("FAIL: cached replay did not behave idempotently");
    process.exit(1);
  }

  // Wave 3: different key - a real new execution
  const otherId = `${REQUEST_ID}-other`;
  const wave3 = report("Wave 3: different key (new payment)", await spawnWave(otherId, 99.9));
  const after3 = await stats();
  console.log(`server executions : ${after3.executed - after2.executed} (should be 1)`);
  if (wave3.unique.size !== 1 || after3.executed - after2.executed !== 1) {
    console.error("FAIL: distinct key did not execute exactly once");
    process.exit(1);
  }

  console.log("\nAll checks passed: idempotency works under concurrent multi-threaded load.");
  console.log(`Final server stats: ${JSON.stringify(after3)}`);
}

main().catch((e) => {
  console.error("Client failed:", e);
  console.error("Is the server running?  bun run src/server.ts");
  process.exit(1);
});
