/**
 * Worker thread for the demo client. Each worker is a real OS thread
 * that fires HTTP POSTs at the payment server and reports results
 * back to the main thread.
 */

export interface WorkerRequest {
  url: string;
  requestId: string;
  body: { fromAccount: string; toAccount: string; amount: number };
  calls: number;
}

export interface WorkerResult {
  workerId: number;
  transferIds: string[];
  errors: string[];
}

const ctx = globalThis as unknown as {
  postMessage: (message: unknown) => void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
};

ctx.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const { url, requestId, body, calls } = event.data;
  const workerId = (event.data as WorkerRequest & { workerId?: number }).workerId ?? 0;

  const transactionIds: string[] = [];
  const errors: string[] = [];

  // Fire this worker's calls concurrently.
  const results = await Promise.allSettled(
    Array.from({ length: calls }, () =>
      fetch(`${url}/payments/${requestId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (res) => {
        const json = (await res.json()) as { transferId?: string; error?: string };
        if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
        return json.transferId!;
      }),
    ),
  );

  for (const r of results) {
    if (r.status === "fulfilled") transactionIds.push(r.value);
    else errors.push(String(r.reason));
  }

  ctx.postMessage({ workerId, transferIds: transactionIds, errors } satisfies WorkerResult);
};
