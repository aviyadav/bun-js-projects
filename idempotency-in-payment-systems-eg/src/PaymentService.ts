/**
 * TypeScript port of the Java PaymentService idempotency pattern.
 *
 * Mapping from Java -> Bun:
 *  - ConcurrentHashMap.compute()  -> Map + synchronous check-and-set.
 *    Bun's event loop is single-threaded, so code that runs without an
 *    await between the read and the write is atomic, exactly like the
 *    Java compute() lambda.
 *  - CompletableFuture            -> Promise with externally captured
 *    resolve/reject.
 *  - ScheduledExecutorService     -> setInterval (unref'd, like a daemon
 *    thread it does not keep the process alive).
 *  - Clock                        -> injectable () => epoch millis.
 *
 * Additionally, every request body is fingerprinted. Reusing an idempotency
 * key with a *different* body is rejected with FingerprintMismatchError
 * (HTTP 422) instead of silently returning the original response.
 */

export interface TransferRequest {
  fromAccount: string;
  toAccount: string;
  amount: number;
}

export interface TransferResult {
  transferId: string;
  request: TransferRequest;
  processedAt: string; // ISO-8601 instant
}

export class FingerprintMismatchError extends Error {
  constructor(public readonly requestId: string) {
    super(
      `Idempotency key "${requestId}" was already used with a different request body`,
    );
    this.name = "FingerprintMismatchError";
  }
}

interface CacheEntry {
  createdAt: number; // epoch millis
  fingerprint: string;
  response: Promise<TransferResult>;
  settle: {
    resolve: (r: TransferResult) => void;
    reject: (e: unknown) => void;
  };
}

export type Clock = () => number;

/** The actual bank call. Inject a stub in tests, a real client in prod. */
export type TransferFn = (request: TransferRequest) => Promise<TransferResult>;

export interface PaymentServiceOptions {
  ttlMs: number;
  clock?: Clock;
  transferFn?: TransferFn;
  /** Simulated ledger latency so the single-flight demo is visible. */
  paymentLatencyMs?: number;
}

function fingerprintOf(request: TransferRequest): string {
  return JSON.stringify([request.fromAccount, request.toAccount, request.amount]);
}

export class PaymentService {
  private readonly storage = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly clock: Clock;
  private readonly transferFn: TransferFn;
  private readonly paymentLatencyMs: number;
  private readonly evictTimer: ReturnType<typeof setInterval>;

  // Observability counters for the demo endpoints.
  public readonly stats = {
    requests: 0, // total transfer() calls
    executed: 0, // times doTransfer (the bank call) actually ran
    coalesced: 0, // requests served from an in-flight/completed entry
    rejected: 0, // fingerprint mismatches
    failures: 0, // bank calls that threw
    evictions: 0,
  };

  constructor(opts: PaymentServiceOptions) {
    this.ttlMs = opts.ttlMs;
    this.clock = opts.clock ?? (() => Date.now());
    this.transferFn = opts.transferFn ?? ((r) => this.defaultTransfer(r));
    this.paymentLatencyMs = opts.paymentLatencyMs ?? 300;
    this.evictTimer = setInterval(() => this.evict(), 2 * 60 * 1000);
    // Like the daemon eviction thread: don't block process shutdown.
    this.evictTimer.unref();
  }

  async transfer(requestId: string, request: TransferRequest): Promise<TransferResult> {
    this.stats.requests++;

    let resolve!: (r: TransferResult) => void;
    let reject!: (e: unknown) => void;
    const response = new Promise<TransferResult>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const newEntry: CacheEntry = {
      createdAt: this.clock(),
      fingerprint: fingerprintOf(request),
      response,
      settle: { resolve, reject },
    };

    // --- the "compute" section: synchronous, therefore atomic ---
    let mismatch: FingerprintMismatchError | null = null;
    const actual = (() => {
      const existing = this.storage.get(requestId);
      if (existing && !this.isExpired(existing)) {
        if (existing.fingerprint !== newEntry.fingerprint) {
          mismatch = new FingerprintMismatchError(requestId); // live key, different body
          return existing;
        }
        return existing; // live entry - keep it
      }
      this.storage.set(requestId, newEntry); // expired or absent - replace
      return newEntry;
    })();

    if (mismatch) {
      this.stats.rejected++;
      throw mismatch;
    }

    if (actual === newEntry) {
      // only one caller ever gets here per requestId
      this.stats.executed++;
      try {
        const result = await this.doTransfer(request);
        actual.settle.resolve(result);
      } catch (e) {
        this.stats.failures++;
        actual.settle.reject(e);
        // Mark the shared promise as handled so a lone failed caller doesn't
        // trigger an unhandled rejection; coalesced waiters still see the error.
        actual.response.catch(() => {});
        // remove newEntry (identity-checked), not whatever is there now
        this.removeEntry(requestId, newEntry);
        throw e;
      }
    } else {
      this.stats.coalesced++;
    }

    try {
      // future.get(30, TimeUnit.SECONDS) equivalent
      return await Promise.race([
        actual.response,
        this.timeoutAfter(30_000),
      ]);
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  /** Peek at the cached entry for a requestId, if any. */
  peek(requestId: string): {
    createdAt: string;
    fingerprint: string;
    response: TransferResult;
  } | null {
    const entry = this.storage.get(requestId);
    if (!entry) return null;
    return {
      createdAt: new Date(entry.createdAt).toISOString(),
      fingerprint: entry.fingerprint,
      response: entry.response as never,
    };
  }

  private isExpired(entry: CacheEntry): boolean {
    return this.clock() > entry.createdAt + this.ttlMs;
  }

  private removeEntry(requestId: string, entry: CacheEntry): void {
    const current = this.storage.get(requestId);
    if (current === entry) {
      this.storage.delete(requestId);
    }
  }

  private evict(): void {
    for (const [key, entry] of this.storage) {
      if (this.isExpired(entry)) {
        this.storage.delete(key);
        this.stats.evictions++;
      }
    }
  }

  /** Delegates to the injected bank-call function. */
  private doTransfer(request: TransferRequest): Promise<TransferResult> {
    return this.transferFn(request);
  }

  /**
   * Default simulated ledger. Only ever invoked once per live requestId.
   * Replace `transferFn` in options to plug in a real payment processor.
   */
  private async defaultTransfer(request: TransferRequest): Promise<TransferResult> {
    // Simulated bank latency: the window in which duplicate callers pile up.
    await Bun.sleep(this.paymentLatencyMs);

    if (request.amount <= 0) {
      throw new Error(`Invalid amount: ${request.amount}`);
    }
    if (request.fromAccount === request.toAccount) {
      throw new Error("fromAccount and toAccount must differ");
    }

    return {
      transferId: crypto.randomUUID(),
      request,
      processedAt: new Date(this.clock()).toISOString(),
    };
  }

  private timeoutAfter(ms: number): Promise<never> {
    return new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Timed out after ${ms}ms waiting for transfer`)), ms),
    );
  }

  shutdown(): void {
    clearInterval(this.evictTimer);
  }
}
