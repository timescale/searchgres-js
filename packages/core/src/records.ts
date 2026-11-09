import type postgres from "postgres";
import { z } from "zod";
import { vectorIndexNameForMethod } from "./db/template.ts";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  InvalidInputError,
  NotFoundError,
  SearchgresError,
  StaleVersionError,
} from "./errors.ts";
import { assertTreePath, isValidTreePath } from "./identifiers.ts";
import type { Index } from "./open-index.ts";
import { mapInputSqlError, postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import { normalizeTemporalTuple, temporalTupleSchema } from "./temporal.ts";
import { metaSchema, toValidationIssue } from "./validation.ts";

/** A full record read back from the index. */
export interface StoredRecord {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly hasEmbedding: boolean;
  readonly version: string;
  readonly versionHash: string;
  readonly createdAt: Date;
  readonly updatedAt: Date | null;
}

interface RecordRow {
  readonly id: string;
  readonly content: string;
  readonly meta: Record<string, unknown>;
  readonly tree: string;
  readonly temporal: string | null;
  readonly name: string | null;
  readonly has_embedding: boolean;
  readonly version: string;
  readonly version_hash: string;
  readonly created_at: Date;
  readonly updated_at: Date | null;
}

interface PatchRow extends RecordRow {
  readonly found: boolean;
  readonly updated: boolean;
}

const idSchema = z.uuidv7({ error: "expected a UUIDv7" });

const patchSchema = z
  .object({
    content: z.string().min(1, "content must not be empty").optional(),
    meta: metaSchema.optional(),
    tree: z
      .string()
      .refine(
        isValidTreePath,
        "expected a dotted ltree path (or the empty root)",
      )
      .optional(),
    name: z
      .string()
      .min(1, "name must not be empty; use null for an unnamed record")
      .nullable()
      .optional(),
    temporal: temporalTupleSchema.nullable().optional(),
    embedding: z.array(z.number().finite()).readonly().optional(),
  })
  .strict()
  .refine(
    (patch) => Object.values(patch).some((value) => value !== undefined),
    "patch must set at least one field",
  );

/** Fields a {@link Index.patch} may change. Omit a key to leave it unchanged. */
export type PatchInput = z.input<typeof patchSchema>;

export interface ReindexVectorIndexOptions {
  /**
   * When `true`, runs `REINDEX INDEX CONCURRENTLY` outside a transaction block
   * so reads and writes on the table are not blocked during the rebuild.
   * Default: `false`.
   */
  readonly concurrently?: boolean;
  /** Optional lock wait budget in milliseconds (`0` disables). */
  readonly lockTimeoutMs?: number;
  /**
   * Optional statement timeout in milliseconds (`0` disables). The rebuild also
   * uses it as its `transaction_timeout`, so a shorter session limit does not
   * end the rebuild.
   */
  readonly statementTimeoutMs?: number;
}

const reindexOptionsSchema = z.strictObject({
  concurrently: z.boolean().optional(),
  lockTimeoutMs: z.int().nonnegative().optional(),
  statementTimeoutMs: z.int().nonnegative().optional(),
});

export async function get(index: Index, id: string): Promise<StoredRecord> {
  const recordId = parseId(id);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<RecordRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.get_record(${recordId})
    `,
    index.schema,
    "getRecord",
  );
  if (!row) {
    throw new NotFoundError(recordId);
  }
  return mapRecord(row);
}

export async function getByName(
  index: Index,
  tree: string,
  name: string,
): Promise<StoredRecord> {
  const treePath = assertTreePath(tree);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<RecordRow[]>`
      select id, content, meta, tree, temporal, name, has_embedding,
             version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.get_record_by_name(${treePath}, ${name})
    `,
    index.schema,
    "getRecordByName",
  );
  if (!row) {
    throw new NotFoundError({ tree: treePath, name });
  }
  return mapRecord(row);
}

export async function patch(
  index: Index,
  id: string,
  priorVersionHash: string,
  input: PatchInput,
): Promise<StoredRecord> {
  const recordId = parseId(id);
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) {
    throwInvalidInput(parsed.error);
  }
  const data = parsed.data;

  if (
    data.embedding !== undefined &&
    data.embedding.length !== index.dimensions
  ) {
    throw new DimensionMismatchError(index.dimensions, data.embedding.length);
  }

  const patchObject: Record<string, unknown> = {};
  if (data.content !== undefined) patchObject.content = data.content;
  if (data.meta !== undefined) patchObject.meta = data.meta;
  if (data.tree !== undefined) patchObject.tree = data.tree;
  if (data.name !== undefined) patchObject.name = data.name;
  if (data.temporal !== undefined) {
    patchObject.temporal =
      data.temporal === null ? null : normalizeTemporalTuple(data.temporal);
  }

  const { sql } = index;
  const embedding =
    data.embedding === undefined
      ? sql`null`
      : index.vectorType === "halfvec"
        ? sql`${JSON.stringify(data.embedding)}::public.halfvec`
        : sql`${JSON.stringify(data.embedding)}::public.vector`;

  const [row] = await runRecordSql(
    sql<PatchRow[]>`
      select found, updated, id, content, meta, tree, temporal, name,
             has_embedding, version, version_hash, created_at, updated_at
      from ${sql(index.schema)}.patch_record
      ( ${recordId}
      , ${priorVersionHash}
      , ${sql.json(patchObject as never)}::jsonb
      , ${embedding}
      )
    `,
    index.schema,
    "patchRecord",
  );
  if (!row?.found) {
    throw new NotFoundError(recordId);
  }
  if (!row.updated) {
    throw new StaleVersionError(recordId);
  }
  return mapRecord(row);
}

export async function deleteRecord(index: Index, id: string): Promise<void> {
  const recordId = parseId(id);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<{ ok: boolean }[]>`
      select ${sql(index.schema)}.delete_record(${recordId}) as ok
    `,
    index.schema,
    "deleteRecord",
  );
  if (!row?.ok) {
    throw new NotFoundError(recordId);
  }
}

export async function deleteByName(
  index: Index,
  tree: string,
  name: string,
): Promise<void> {
  const treePath = assertTreePath(tree);
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<{ ok: boolean }[]>`
      select ${sql(index.schema)}.delete_record_by_name(${treePath}, ${name}) as ok
    `,
    index.schema,
    "deleteRecordByName",
  );
  if (!row?.ok) {
    throw new NotFoundError({ tree: treePath, name });
  }
}

async function runRecordSql<T extends readonly unknown[]>(
  query: postgres.PendingQuery<T & readonly object[]>,
  schema: string,
  spanName: string,
): Promise<T> {
  try {
    return (await runSql(query, {
      spanName,
      dbOperationName: "SELECT",
      namespace: schema,
    })) as T;
  } catch (error) {
    if (error instanceof SearchgresError) {
      throw error;
    }
    const code = postgresErrorCode(error);
    if (code === "23505") {
      throw new ConflictError("The target (tree, name) is already occupied", {
        cause: error,
      });
    }
    throw mapInputSqlError(error, "patch input") ?? error;
  }
}

function mapRecord(row: RecordRow): StoredRecord {
  return {
    id: row.id,
    content: row.content,
    meta: row.meta,
    tree: row.tree,
    temporal: row.temporal,
    name: row.name,
    hasEmbedding: row.has_embedding,
    version: row.version,
    versionHash: row.version_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The most ids that one {@link deleteMany} call accepts. */
const MAX_DELETE_BATCH_SIZE = 1000;

/** The result of {@link deleteMany}. */
export interface DeleteManyResult {
  /** Records removed. Ids that did not exist, and repeated ids, add nothing. */
  readonly count: number;
}

/**
 * Delete up to 1,000 records by id in one statement. A missing id is not an
 * error. An invalid id fails the whole call before anything is deleted.
 */
export async function deleteMany(
  index: Index,
  ids: readonly string[],
): Promise<DeleteManyResult> {
  if (!Array.isArray(ids)) {
    throw new InvalidInputError("deleteMany expects an array of record ids", {
      issues: [
        { code: "invalid_type", message: "expected an array", path: [] },
      ],
    });
  }
  if (ids.length > MAX_DELETE_BATCH_SIZE) {
    throw new BatchTooLargeError(ids.length, MAX_DELETE_BATCH_SIZE);
  }
  const parsed = z.array(idSchema).safeParse(ids);
  if (!parsed.success) {
    const issues = parsed.error.issues.map(toValidationIssue);
    const first = issues[0];
    throw new InvalidInputError(
      `Invalid record ids: ${first ? `${first.path.join(".")}: ${first.message}` : "validation failed"}`,
      { cause: parsed.error, issues },
    );
  }
  const unique = [...new Set(parsed.data)];
  if (unique.length === 0) {
    return { count: 0 };
  }
  const { sql } = index;
  const [row] = await runRecordSql(
    sql<{ count: string }[]>`
      select ${sql(index.schema)}.delete_records(${unique}::text[]::uuid[]) as count
    `,
    index.schema,
    "deleteRecords",
  );
  return { count: Number(row?.count ?? 0) };
}

function parseId(id: string): string {
  const result = idSchema.safeParse(id);
  if (!result.success) {
    throw new InvalidInputError(
      `Invalid record id ${JSON.stringify(id)}: expected a UUIDv7`,
      { cause: result.error },
    );
  }
  return result.data;
}

export async function reindexVectorIndex(
  index: Index,
  options?: ReindexVectorIndexOptions,
): Promise<void> {
  const parsed = reindexOptionsSchema.safeParse(options ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "options"}: ${first.message}`
      : "validation failed";
    throw new InvalidInputError(
      `Invalid reindexVectorIndex options: ${detail}`,
      {
        cause: parsed.error,
        issues,
      },
    );
  }
  const {
    concurrently = false,
    lockTimeoutMs,
    statementTimeoutMs,
  } = parsed.data;
  const indexName = vectorIndexNameForMethod(index.vectorIndex);
  const { sql } = index;

  if (
    "savepoint" in sql ||
    typeof (sql as postgres.Sql).begin !== "function" ||
    typeof (sql as postgres.Sql).reserve !== "function"
  ) {
    throw new InvalidInputError(
      "Cannot run reindexVectorIndex inside a transaction",
    );
  }
  const pool = sql as postgres.Sql;

  // PostgreSQL arms transaction_timeout when a transaction starts, and the
  // timeout ends the session. So set the timeouts on one reserved session
  // before the rebuild starts, and restore the prior values after it.
  // statementTimeoutMs also sets transaction_timeout, so that a session limit
  // cannot end a rebuild that the caller gave more time.
  const reserved = await pool.reserve();
  let prior: SessionTimeouts | undefined;
  try {
    if (lockTimeoutMs !== undefined || statementTimeoutMs !== undefined) {
      prior = await readSessionTimeouts(reserved, index.schema);
      await applyReindexTimeouts(
        reserved,
        index.schema,
        lockTimeoutMs,
        statementTimeoutMs,
      );
    }
    if (concurrently) {
      await refreshPrismRowEstimate(reserved, index);
      await runSql(
        reserved`reindex index concurrently ${reserved(index.schema)}.${reserved(indexName)}`,
        {
          spanName: "reindexVectorIndex",
          dbOperationName: "REINDEX",
          namespace: index.schema,
        },
      );
    } else {
      await reserved`begin`;
      try {
        await refreshPrismRowEstimate(reserved, index);
        await runSql(
          reserved`reindex index ${reserved(index.schema)}.${reserved(indexName)}`,
          {
            spanName: "reindexVectorIndex",
            dbOperationName: "REINDEX",
            namespace: index.schema,
          },
        );
        await reserved`commit`;
      } catch (error) {
        await reserved`rollback`.catch(() => {});
        throw error;
      }
    }
  } finally {
    try {
      if (prior !== undefined) {
        await restoreSessionTimeouts(reserved, prior);
      }
    } finally {
      reserved.release();
    }
  }
}

interface SessionTimeouts {
  readonly lock_timeout: string;
  readonly statement_timeout: string;
  readonly transaction_timeout: string;
}

async function readSessionTimeouts(
  sql: postgres.ISql,
  schema: string,
): Promise<SessionTimeouts | undefined> {
  const [row] = await runSql(
    sql<SessionTimeouts[]>`
      select
        pg_catalog.current_setting('lock_timeout') as lock_timeout
      , pg_catalog.current_setting('statement_timeout') as statement_timeout
      , pg_catalog.current_setting('transaction_timeout') as transaction_timeout
    `,
    {
      spanName: "readSessionTimeouts",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  return row;
}

async function restoreSessionTimeouts(
  sql: postgres.ISql,
  prior: SessionTimeouts,
): Promise<void> {
  await sql`
    select
      pg_catalog.set_config('lock_timeout', ${prior.lock_timeout}, false)
    , pg_catalog.set_config('statement_timeout', ${prior.statement_timeout}, false)
    , pg_catalog.set_config('transaction_timeout', ${prior.transaction_timeout}, false)
  `;
}

/**
 * A prism build sizes nlist from pg_class.reltuples when that value is
 * positive. A previous build or ANALYZE can leave it stale after a bulk load,
 * so a rebuild would keep the old width. ANALYZE refreshes the estimate first.
 */
async function refreshPrismRowEstimate(
  sql: postgres.ISql,
  index: Index,
): Promise<void> {
  if (index.vectorIndex !== "prism") return;
  await runSql(sql`analyze ${sql(index.schema)}.record`, {
    spanName: "analyzeRecordTable",
    dbOperationName: "ANALYZE",
    namespace: index.schema,
  });
}

async function applyReindexTimeouts(
  sql: postgres.ISql,
  schema: string,
  lockTimeoutMs: number | undefined,
  statementTimeoutMs: number | undefined,
): Promise<void> {
  if (lockTimeoutMs !== undefined) {
    await runSql(
      sql`select pg_catalog.set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, false)`,
      {
        spanName: "setLockTimeout",
        dbOperationName: "SET",
        namespace: schema,
      },
    );
  }
  if (statementTimeoutMs !== undefined) {
    await runSql(
      sql`
        select
          pg_catalog.set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, false)
        , pg_catalog.set_config('transaction_timeout', ${`${statementTimeoutMs}ms`}, false)
      `,
      {
        spanName: "setStatementTimeout",
        dbOperationName: "SET",
        namespace: schema,
      },
    );
  }
}

function throwInvalidInput(error: z.ZodError): never {
  const issues = error.issues.map(toValidationIssue);
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "patch"}: ${first.message}`
    : "validation failed";
  throw new InvalidInputError(`Invalid patch: ${detail}`, {
    cause: error,
    issues,
  });
}
