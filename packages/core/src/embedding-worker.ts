import type { Span } from "@opentelemetry/api";
import {
  claimBatch,
  completeEmbedding,
  failEmbedding,
  failEmbeddingPermanently,
  pendingCount,
  pruneQueue,
  releaseEmbedding,
} from "./db/embedding-queue.ts";
import {
  assertEmbeddingAvailable,
  assertPrefixFits,
  boundedError,
  embedTexts,
  resolveBatchSize,
} from "./embedding.ts";
import {
  DimensionMismatchError,
  InvalidConfigError,
  RateLimitError,
} from "./errors.ts";
import type { Index } from "./open-index.ts";
import {
  runDetached,
  runNonActiveOperation,
  runOperation,
} from "./operation.ts";

const DEFAULT_LEASE_MS = 300_000; // 5 minutes
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PRUNE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_WORKER_INTERVAL_MS = 1_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 1_000;
const MAX_ERROR_BACKOFF_MS = 60_000;

/** Options shared by the bounded pass and the continuous worker. */
interface DrainTuning {
  /** Rows to claim/embed per batch. Clamped to the model's max-per-call. */
  readonly batchSize?: number;
  /** Claim lease before a crashed drainer's rows become reclaimable. */
  readonly leaseDurationMs?: number;
  /** Attempts before a row is terminally failed. */
  readonly maxAttempts?: number;
}

export interface ProcessEmbeddingsOptions extends DrainTuning {
  /** Stop after this many batches (default: drain until no claimable work). */
  readonly maxBatches?: number;
  /** Stop once this wall-clock budget is exceeded (checked between batches). */
  readonly maxDurationMs?: number;
  /** Cooperative cancellation, checked before each claim. */
  readonly signal?: AbortSignal;
}

export interface ProcessEmbeddingsResult {
  /** Rows claimed for embedding across the pass. */
  readonly claimed: number;
  /** Vectors written back and finalized `completed`. */
  readonly embedded: number;
  /** Rows whose provider/write-back failed this pass (still pending to retry). */
  readonly failed: number;
  /** Rows cancelled as stale (at claim, or superseded before write-back). */
  readonly cancelled: number;
  /** `outcome is null` rows remaining after the pass. */
  readonly remaining: number;
  /**
   * The first error that made rows fail in this pass, or `null` when no row
   * failed. Use it to see why rows failed: the queue keeps only a bounded
   * message. A provider failure is an `EmbeddingProviderError` with the
   * provider error as its `cause`. It can contain provider text, so redact it
   * before you show it to untrusted users.
   */
  readonly sampleError: Error | null;
}

export interface EmbeddingWorkerOptions extends DrainTuning {
  /** Idle delay between polls when no work was found (default 1s). */
  readonly intervalMs?: number;
  /** Retention for terminal rows the idle worker opportunistically prunes. */
  readonly pruneRetentionMs?: number;
  /**
   * Called when a tick fails. The worker keeps running and backs off, except
   * after a configuration fault, when it stops (`context.stopped`). This
   * is the only channel by which a caller learns that a
   * model is misconfigured, a key was revoked, or the database is unreachable.
   * Without it the worker retries silently (OTel spans still record the
   * failure). A throwing callback is ignored.
   */
  readonly onError?: (error: unknown, context: WorkerErrorContext) => void;
}

/** What the worker was doing when it failed, and how it is reacting. */
export interface WorkerErrorContext {
  /** `process`: a drain pass threw. `prune`: idle pruning of terminal rows. */
  readonly phase: "process" | "prune";
  /**
   * Consecutive failed drain passes, including this one. A rate limit is not
   * counted as a failure; `prune` reports 0.
   */
  readonly consecutiveErrors: number;
  /** How long the worker will sleep before its next attempt. */
  readonly backoffMs: number;
  /**
   * True when the worker stopped after this error and claims no more work.
   * This occurs after a `DimensionMismatchError` (the model returns vectors
   * that the index cannot store) or an `InvalidConfigError` (the
   * `documentPrefix` does not fit the truncation budget). A retry with the
   * same handle cannot succeed. Open a handle with a correct configuration,
   * retry any failures, and start a new worker.
   */
  readonly stopped: boolean;
}

export interface EmbeddingWorker {
  /** Stop polling and resolve once the in-flight batch (if any) finishes. */
  stop(): Promise<void>;
}

interface BatchOutcome {
  readonly claimed: number;
  readonly embedded: number;
  readonly failed: number;
  readonly cancelled: number;
  /** The first error that made a row fail in this batch. */
  readonly error?: Error;
}

/**
 * Run a bounded drain pass: claim → embed (outside any transaction) →
 * version-guarded write-back, repeated until a batch claims nothing or a bound
 * is hit. A provider rate limit aborts the pass by throwing after it releases
 * and refunds the claimed rows. A wrong-dimension model output aborts the pass
 * by throwing after it fails the claimed rows permanently. Ordinary provider
 * failures are recorded and reflected in `failed` and `sampleError` while the
 * pass continues.
 */
export async function processEmbeddings(
  index: Index,
  options: ProcessEmbeddingsOptions = {},
  span: Span,
): Promise<ProcessEmbeddingsResult> {
  assertEmbeddingAvailable(index, "process embeddings");
  // Check before any claim: a prefix that does not fit fails every row.
  await assertPrefixFits(index, "document");
  const pass = await drainPass(
    index,
    {
      batchSize: await resolveBatchSize(index, options.batchSize),
      leaseMs: options.leaseDurationMs ?? DEFAULT_LEASE_MS,
      maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      maxBatches: options.maxBatches ?? Number.POSITIVE_INFINITY,
      deadline:
        options.maxDurationMs === undefined
          ? Number.POSITIVE_INFINITY
          : Date.now() + options.maxDurationMs,
      ...(options.signal ? { signal: options.signal } : {}),
      countRemaining: true,
    },
    span,
  );
  return { ...pass, remaining: pass.remaining ?? 0 };
}

/** Fully resolved parameters for one drain pass. */
interface DrainPassOptions {
  readonly batchSize: number;
  readonly leaseMs: number;
  readonly maxAttempts: number;
  readonly maxBatches: number;
  readonly deadline: number;
  readonly signal?: AbortSignal;
  /**
   * Whether to `count(*)` the pending queue after the pass. The public
   * `processEmbeddings` reports it as `remaining`; the continuous worker
   * decides idleness from `claimed`/`cancelled` alone and skips the count,
   * which would otherwise run once per tick even on an idle queue.
   */
  readonly countRemaining: boolean;
}

type DrainPassResult = Omit<ProcessEmbeddingsResult, "remaining"> & {
  readonly remaining?: number;
};

async function drainPass(
  index: Index,
  options: DrainPassOptions,
  span: Span,
): Promise<DrainPassResult> {
  const { batchSize, leaseMs, maxAttempts, maxBatches, deadline, signal } =
    options;
  let claimed = 0;
  let embedded = 0;
  let failed = 0;
  let cancelled = 0;
  let sampleError: Error | null = null;
  for (let batch = 0; batch < maxBatches; batch++) {
    if (signal?.aborted || Date.now() >= deadline) {
      break;
    }
    const outcome = await runBatch(index, span, {
      batchSize,
      leaseMs,
      maxAttempts,
    });
    claimed += outcome.claimed;
    embedded += outcome.embedded;
    failed += outcome.failed;
    cancelled += outcome.cancelled;
    sampleError ??= outcome.error ?? null;
    // A batch that claimed nothing means the queue is drained for now.
    if (outcome.claimed === 0 && outcome.cancelled === 0) {
      break;
    }
  }
  span.setAttributes({
    "searchgres.embedding.claimed": claimed,
    "searchgres.embedding.embedded": embedded,
    "searchgres.embedding.failed": failed,
    "searchgres.embedding.cancelled": cancelled,
  });
  if (!options.countRemaining) {
    return { claimed, embedded, failed, cancelled, sampleError };
  }
  const remaining = await pendingCount(index.sql, index.schema);
  span.setAttribute("searchgres.embedding.remaining", remaining);
  return { claimed, embedded, failed, cancelled, remaining, sampleError };
}

async function runBatch(
  index: Index,
  span: Span,
  tuning: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  },
): Promise<BatchOutcome> {
  const { rows, cancelled: cancelledAtClaim } = await claimBatch(
    index.sql,
    index.schema,
    tuning,
  );
  if (rows.length === 0) {
    return { claimed: 0, embedded: 0, failed: 0, cancelled: cancelledAtClaim };
  }

  let embeddings: readonly (readonly number[])[];
  try {
    embeddings = await embedTexts(
      index,
      rows.map((row) => row.content),
      "document",
    );
  } catch (error) {
    // A rate limit is a batch-level fault, not a per-row failure: refund the
    // attempts and free the rows for a later retry, then propagate so the
    // caller can react.
    if (error instanceof RateLimitError) {
      const backoffMs = rateLimitBackoffMs(error.retryAfterMs);
      for (const row of rows) {
        await releaseEmbedding(index.sql, index.schema, {
          queueId: row.queueId,
          backoffMs,
        });
      }
      throw error;
    }
    // A wrong dimension is a configuration fault. A retry with the same model
    // cannot succeed, so fail the rows permanently (they become visible as
    // failures) and propagate so the pass or worker stops.
    if (error instanceof DimensionMismatchError) {
      const message = boundedError(error);
      for (const row of rows) {
        await failEmbeddingPermanently(index.sql, index.schema, {
          queueId: row.queueId,
          error: message,
        });
      }
      throw error;
    }
    // Ordinary provider failure: record it, leave rows pending; the queue is the
    // retry authority (they reappear after the lease and are terminally failed
    // once attempts are exhausted).
    const message = boundedError(error);
    // The pass itself succeeds (the failure is recorded in the queue), so this
    // is an event on the pass span rather than an error status.
    span.addEvent("embedding.batch_failed", {
      "searchgres.embedding.rows": rows.length,
      "exception.message": message,
    });
    for (const row of rows) {
      await failEmbedding(index.sql, index.schema, {
        queueId: row.queueId,
        error: message,
      });
    }
    return {
      claimed: rows.length,
      embedded: 0,
      failed: rows.length,
      cancelled: cancelledAtClaim,
      error: asError(error),
    };
  }

  let embedded = 0;
  let failed = 0;
  let cancelled = cancelledAtClaim;
  let firstError: Error | undefined;
  for (let position = 0; position < rows.length; position++) {
    const row = rows[position];
    const embedding = embeddings[position];
    if (!row || !embedding) {
      continue;
    }
    try {
      const outcome = await completeEmbedding(
        index.sql,
        index.schema,
        index.vectorType,
        {
          queueId: row.queueId,
          recordId: row.recordId,
          contentVersion: row.contentVersion,
          embedding: JSON.stringify(embedding),
        },
      );
      if (outcome === "completed") {
        embedded++;
      } else {
        cancelled++;
      }
    } catch (error) {
      failed++;
      firstError ??= asError(error);
      await failEmbedding(index.sql, index.schema, {
        queueId: row.queueId,
        error: boundedError(error),
      });
    }
  }
  return {
    claimed: rows.length,
    embedded,
    failed,
    cancelled,
    ...(firstError === undefined ? {} : { error: firstError }),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Start a continuous single-index drainer. Processes one batch per tick,
 * continuing immediately while work exists and sleeping `intervalMs` when idle;
 * an idle tick opportunistically prunes terminal rows. `stop()` interrupts the
 * idle sleep and prevents another claim, but lets an in-flight batch finish, and
 * never closes the caller-owned pool.
 */
export function startEmbeddingWorker(
  index: Index,
  options: EmbeddingWorkerOptions = {},
): EmbeddingWorker {
  return runNonActiveOperation(
    "searchgres.embedding.worker.start",
    { schema: index.schema },
    () => startEmbeddingWorkerLoop(index, options),
  );
}

function startEmbeddingWorkerLoop(
  index: Index,
  options: EmbeddingWorkerOptions,
): EmbeddingWorker {
  assertEmbeddingAvailable(index, "start the embedding worker");
  const intervalMs = options.intervalMs ?? DEFAULT_WORKER_INTERVAL_MS;
  const pruneRetentionMs =
    options.pruneRetentionMs ?? DEFAULT_PRUNE_RETENTION_MS;
  const controller = new AbortController();
  const { signal } = controller;
  const report = (error: unknown, context: WorkerErrorContext) => {
    try {
      options.onError?.(error, context);
    } catch {
      // A failing observer must never take the worker down.
    }
  };

  const leaseMs = options.leaseDurationMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  const loop = runDetached(async () => {
    let consecutiveErrors = 0;
    // The model's max-per-call is static, so resolve the clamp once per worker
    // rather than once per tick. Resolved lazily inside the loop so a failing
    // model surfaces through the same onError/backoff path as a failing batch.
    let batchSize: number | undefined;
    while (!signal.aborted) {
      try {
        if (batchSize === undefined) {
          // Check before the first claim: a prefix that does not fit fails
          // every row, and a retry with this handle cannot succeed.
          await assertPrefixFits(index, "document");
        }
        const effectiveBatchSize =
          batchSize ?? (await resolveBatchSize(index, options.batchSize));
        batchSize = effectiveBatchSize;
        // One batch per iteration; `signal` lets stop() land between batches.
        // Idleness is decided from `claimed`/`cancelled`, so skip the pending
        // count that processEmbeddings reports as `remaining`.
        const result = await runOperation(
          "searchgres.embedding.process",
          { schema: index.schema },
          async (span) => {
            const outcome = await drainPass(
              index,
              {
                batchSize: effectiveBatchSize,
                leaseMs,
                maxAttempts,
                maxBatches: 1,
                deadline: Number.POSITIVE_INFINITY,
                signal,
                countRemaining: false,
              },
              span,
            );
            // Idle: prune terminal rows inside the tick span. Pruning remains
            // best-effort and never turns a successful drain pass into an
            // operation failure.
            if (outcome.claimed === 0 && outcome.cancelled === 0) {
              try {
                await pruneQueue(index.sql, index.schema, pruneRetentionMs);
              } catch (error) {
                report(error, {
                  phase: "prune",
                  consecutiveErrors: 0,
                  backoffMs: intervalMs,
                  stopped: false,
                });
              }
            }
            return outcome;
          },
        );
        consecutiveErrors = 0;
        if (result.claimed > 0 || result.cancelled > 0) {
          continue; // keep draining while there is work
        }
        await sleep(intervalMs, signal);
      } catch (error) {
        if (error instanceof RateLimitError) {
          const backoffMs = rateLimitBackoffMs(error.retryAfterMs);
          report(error, {
            phase: "process",
            consecutiveErrors,
            backoffMs,
            stopped: false,
          });
          await sleep(backoffMs, signal);
          continue;
        }
        consecutiveErrors++;
        if (
          error instanceof DimensionMismatchError ||
          error instanceof InvalidConfigError
        ) {
          report(error, {
            phase: "process",
            consecutiveErrors,
            backoffMs: 0,
            stopped: true,
          });
          break;
        }
        // Bounded exponential backoff on repeated errors so a persistent
        // failure (e.g. an unreachable provider) doesn't hot-loop.
        const backoffMs = Math.min(
          intervalMs * 2 ** (consecutiveErrors - 1),
          MAX_ERROR_BACKOFF_MS,
        );
        report(error, {
          phase: "process",
          consecutiveErrors,
          backoffMs,
          stopped: false,
        });
        await sleep(backoffMs, signal);
      }
    }
  });

  return {
    stop() {
      return runOperation(
        "searchgres.embedding.worker.stop",
        { schema: index.schema },
        async () => {
          controller.abort();
          await loop;
        },
      );
    },
  };
}

function rateLimitBackoffMs(retryAfterMs: number | undefined): number {
  return retryAfterMs !== undefined && retryAfterMs > 0
    ? retryAfterMs
    : DEFAULT_RATE_LIMIT_BACKOFF_MS;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
