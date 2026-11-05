import type postgres from "postgres";
import { z } from "zod";
import type { VectorType } from "../config.ts";
import { InvalidInputError } from "../errors.ts";
import { runSql } from "../sql/exec.ts";
import { toValidationIssue } from "../validation.ts";

const MAX_QUEUE_PAGE_SIZE = 1000;
const MAX_RETRY_BATCH_SIZE = 1000;
const POSTGRES_TEXT_OID = 25;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;

const queueIdSchema = z
  .string()
  .regex(/^[1-9]\d*$/, "must be a canonical positive decimal string")
  .refine((value) => {
    try {
      return BigInt(value) <= MAX_POSTGRES_BIGINT;
    } catch {
      return false;
    }
  }, "must fit in a PostgreSQL bigint");

const listEmbeddingFailuresOptionsSchema = z
  .strictObject({
    limit: z.number().int().min(1).max(MAX_QUEUE_PAGE_SIZE).default(100),
    after: queueIdSchema.optional(),
  })
  .default({ limit: 100 });

const retryEmbeddingFailuresOptionsSchema = z.strictObject({
  queueIds: z
    .array(queueIdSchema)
    .min(1)
    .max(MAX_RETRY_BATCH_SIZE)
    .refine(
      (values) => new Set(values).size === values.length,
      "must not contain duplicates",
    )
    .readonly(),
});

/** Options for keyset-paginating current unresolved embedding failures. */
export type ListEmbeddingFailuresOptions = z.input<
  typeof listEmbeddingFailuresOptionsSchema
>;

/** One terminal queue row that still describes its record's current state. */
export interface EmbeddingFailure {
  readonly queueId: string;
  readonly recordId: string;
  readonly contentVersion: number;
  readonly attempts: number;
  readonly lastError: string | null;
  readonly enqueuedAt: Date;
  readonly failedAt: Date;
}

/** Select terminal queue rows to make pending again. */
export type RetryEmbeddingFailuresOptions = z.input<
  typeof retryEmbeddingFailuresOptionsSchema
>;

/** Outcome of an explicit, version-guarded embedding retry request. */
export interface RetryEmbeddingFailuresResult {
  readonly retried: number;
  readonly skipped: number;
}

/**
 * Operational queue wrappers for asynchronous embedding generation.
 *
 * Every operation delegates to a schema-local routine in
 * `idempotent/005_embedding_queue.sql`.
 *
 * Concurrency model (at-least-once lease):
 *  - `claim_embedding_batch` locks eligible rows `for update skip locked`, so
 *    many drainers across processes share one queue without blocking each other.
 *  - Claiming pushes `visible_at` into the future (the lease) and increments
 *    `attempts`, so a crashed drainer's rows become claimable again after the
 *    lease lapses rather than being lost.
 *  - The embedding provider is called OUTSIDE any transaction; write-back is a
 *    separate short call to `complete_embedding`, `fail_embedding`, or
 *    `release_embedding`.
 *  - Every write-back is guarded by the record's `content_version`, so a vector
 *    generated for a stale record state can never overwrite a newer one.
 */

/** A queue row claimed for embedding, paired with the record content to embed. */
export interface ClaimedRow {
  readonly queueId: string;
  readonly recordId: string;
  readonly contentVersion: number;
  readonly content: string;
}

export interface ClaimResult {
  readonly rows: readonly ClaimedRow[];
  /** Candidate rows cancelled during this claim because they were stale. */
  readonly cancelled: number;
}

export interface QueueStats {
  readonly pending: number;
  readonly inFlight: number;
  readonly waiting: number;
  readonly failed: number;
  readonly oldestPendingAt: Date | null;
}

interface CandidateRow {
  readonly queue_id: string;
  readonly record_id: string;
  readonly content_version: number;
  readonly content: string | null;
  readonly claimed: boolean;
}

/**
 * Claim up to `batchSize` rows via `<schema>.claim_embedding_batch`, which
 * sweeps exhausted rows and claims or cancels candidates in one round trip.
 */
export async function claimBatch(
  sql: postgres.ISql,
  schema: string,
  options: {
    readonly batchSize: number;
    readonly leaseMs: number;
    readonly maxAttempts: number;
  },
): Promise<ClaimResult> {
  const candidates = await runSql(
    sql<CandidateRow[]>`
      select
        queue_id::text as queue_id
      , record_id
      , content_version
      , content
      , claimed
      from ${sql(schema)}.claim_embedding_batch
      ( ${options.batchSize}
      , ${options.leaseMs}
      , ${options.maxAttempts}
      )
    `,
    {
      spanName: "claimEmbeddingBatch",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );

  const rows: ClaimedRow[] = [];
  let cancelled = 0;
  for (const candidate of candidates) {
    if (candidate.claimed && candidate.content !== null) {
      rows.push({
        queueId: candidate.queue_id,
        recordId: candidate.record_id,
        contentVersion: candidate.content_version,
        content: candidate.content,
      });
    } else {
      cancelled++;
    }
  }
  return { rows, cancelled };
}

/**
 * Version-guarded write-back via `<schema>.complete_embedding`. Returns
 * `'completed'` when the vector was written, or `'cancelled'` when the record
 * moved on or the queue row was already terminal.
 */
export async function completeEmbedding(
  sql: postgres.ISql,
  schema: string,
  vectorType: VectorType,
  input: {
    readonly queueId: string;
    readonly recordId: string;
    readonly contentVersion: number;
    readonly embedding: string;
  },
): Promise<"completed" | "cancelled"> {
  const vector =
    vectorType === "halfvec"
      ? sql`${input.embedding}::public.halfvec`
      : sql`${input.embedding}::public.vector`;

  const [row] = await runSql(
    sql<{ outcome: "completed" | "cancelled" }[]>`
      select ${sql(schema)}.complete_embedding
      ( ${input.queueId}::pg_catalog.int8
      , ${input.recordId}
      , ${input.contentVersion}
      , ${vector}
      ) as outcome
    `,
    {
      spanName: "completeEmbedding",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return row?.outcome ?? "cancelled";
}

/**
 * Record a transient failure without finalizing via `<schema>.fail_embedding`.
 */
export async function failEmbedding(
  sql: postgres.ISql,
  schema: string,
  input: { readonly queueId: string; readonly error: string },
): Promise<void> {
  await runSql(
    sql`
      select ${sql(schema)}.fail_embedding
      ( ${input.queueId}::pg_catalog.int8
      , ${input.error}
      )
    `,
    { spanName: "failEmbedding", dbOperationName: "SELECT", namespace: schema },
  );
}

/**
 * Undo a claim after a rate limit via `<schema>.release_embedding`: refund the
 * attempt and defer visibility by `backoffMs`.
 */
export async function releaseEmbedding(
  sql: postgres.ISql,
  schema: string,
  input: { readonly queueId: string; readonly backoffMs: number },
): Promise<void> {
  await runSql(
    sql`
      select ${sql(schema)}.release_embedding
      ( ${input.queueId}::pg_catalog.int8
      , ${input.backoffMs}
      )
    `,
    {
      spanName: "releaseEmbedding",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
}

/** Delete terminal rows older than the retention window. Returns rows removed. */
export async function pruneQueue(
  sql: postgres.ISql,
  schema: string,
  retentionMs: number,
): Promise<number> {
  if (!Number.isFinite(retentionMs) || retentionMs < 0) {
    throw new InvalidInputError(
      "pruneEmbeddingQueue retentionMs must be a finite, nonnegative number of milliseconds",
      {
        issues: [
          {
            code: "custom",
            message: "must be a finite, nonnegative number",
            path: ["retentionMs"],
          },
        ],
      },
    );
  }
  const [row] = await runSql(
    sql<{ pruned: string }[]>`
      select ${sql(schema)}.prune_embedding_queue(${retentionMs})::text as pruned
    `,
    {
      spanName: "pruneEmbeddingQueue",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return Number(row?.pruned ?? 0);
}

/** Count of `outcome is null` rows after a bounded pass (used for `remaining`). */
export async function pendingCount(
  sql: postgres.ISql,
  schema: string,
): Promise<number> {
  const [row] = await runSql(
    sql<{ pending: string }[]>`
      select ${sql(schema)}.pending_embedding_count()::text as pending
    `,
    {
      spanName: "pendingEmbeddingCount",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return Number(row?.pending ?? 0);
}

/**
 * List current unresolved terminal failures in ascending queue-id order via
 * `<schema>.list_embedding_failures`.
 */
export async function listEmbeddingFailures(
  sql: postgres.ISql,
  schema: string,
  options?: ListEmbeddingFailuresOptions,
): Promise<readonly EmbeddingFailure[]> {
  const parsed = parseQueueOptions(
    listEmbeddingFailuresOptionsSchema,
    options,
    "listEmbeddingFailures",
  );
  const after =
    parsed.after === undefined
      ? sql`null::pg_catalog.int8`
      : sql`${parsed.after}::pg_catalog.int8`;

  const rows = await runSql(
    sql<
      {
        queue_id: string;
        record_id: string;
        content_version: number;
        attempts: number;
        last_error: string | null;
        enqueued_at: Date;
        failed_at: Date;
      }[]
    >`
      select
        queue_id::text as queue_id
      , record_id
      , content_version
      , attempts
      , last_error
      , enqueued_at
      , failed_at
      from ${sql(schema)}.list_embedding_failures
      ( ${parsed.limit}
      , ${after}
      )
    `,
    {
      spanName: "listEmbeddingFailures",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );

  return rows.map((row) => ({
    queueId: row.queue_id,
    recordId: row.record_id,
    contentVersion: row.content_version,
    attempts: row.attempts,
    lastError: row.last_error,
    enqueuedAt: row.enqueued_at,
    failedAt: row.failed_at,
  }));
}

/**
 * Reset selected current failures to immediately claimable pending work via
 * `<schema>.retry_embedding_failures`.
 */
export async function retryEmbeddingFailures(
  sql: postgres.ISql,
  schema: string,
  options: RetryEmbeddingFailuresOptions,
): Promise<RetryEmbeddingFailuresResult> {
  const parsed = parseQueueOptions(
    retryEmbeddingFailuresOptionsSchema,
    options,
    "retryEmbeddingFailures",
  );
  const [row] = await runSql(
    sql<{ retried: string }[]>`
      select ${sql(schema)}.retry_embedding_failures
      ( ${sql.array([...parsed.queueIds], POSTGRES_TEXT_OID)}::text[]::pg_catalog.int8[]
      )::text as retried
    `,
    {
      spanName: "retryEmbeddingFailures",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  const retried = Number(row?.retried ?? 0);
  return { retried, skipped: parsed.queueIds.length - retried };
}

function parseQueueOptions<T>(
  schema: z.ZodType<T>,
  input: unknown,
  operation: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  const issues = result.error.issues.map(toValidationIssue);
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "options"}: ${first.message}`
    : "validation failed";
  throw new InvalidInputError(`Invalid ${operation} options: ${detail}`, {
    cause: result.error,
    issues,
  });
}

/** Aggregate queue snapshot for operational visibility via `<schema>.embedding_queue_stats`. */
export async function queueStats(
  sql: postgres.ISql,
  schema: string,
): Promise<QueueStats> {
  const [row] = await runSql(
    sql<
      {
        pending: string;
        in_flight: string;
        waiting: string;
        failed: string;
        oldest_pending_at: Date | null;
      }[]
    >`
      select
        pending::text as pending
      , in_flight::text as in_flight
      , waiting::text as waiting
      , failed::text as failed
      , oldest_pending_at
      from ${sql(schema)}.embedding_queue_stats()
    `,
    {
      spanName: "embeddingQueueStats",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return {
    pending: Number(row?.pending ?? 0),
    inFlight: Number(row?.in_flight ?? 0),
    waiting: Number(row?.waiting ?? 0),
    failed: Number(row?.failed ?? 0),
    oldestPendingAt: row?.oldest_pending_at ?? null,
  };
}
