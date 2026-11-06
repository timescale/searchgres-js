import type postgres from "postgres";
import { z } from "zod";
import type { VectorIndexMethod } from "./config.ts";
import { vectorIndexNameForMethod } from "./db/template.ts";
import {
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

const idSchema = z.uuidv7();

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

export type PrismReindexReason = "bootstrap_single_cluster" | "cluster_drift";

export interface PrismIndexStats {
  readonly nlist: number;
  readonly pinnedNlist: number | null;
  readonly idealNlist: number;
  readonly targetPages: number;
  readonly targetEntries: number;
  readonly nlevels: number;
  readonly postingPages: number;
  readonly needsReindex: boolean;
  readonly reindexReason: PrismReindexReason | null;
}

export interface VectorIndexStats {
  readonly method: VectorIndexMethod;
  readonly indexName: string;
  readonly indexSizeBytes: number;
  readonly embeddedRecords: number;
  readonly prism: PrismIndexStats | null;
}

export interface ReindexVectorIndexOptions {
  /**
   * When `true`, runs `REINDEX INDEX CONCURRENTLY` outside a transaction block
   * so reads and writes on the table are not blocked during the rebuild.
   * Default: `false`.
   */
  readonly concurrently?: boolean;
  /**
   * For `prism` indexes: pin `nlist` to a positive integer (`ALTER INDEX ... SET (nlist = N)`)
   * or unpin it back to automatic optimal sizing (`"auto"` -> `ALTER INDEX ... RESET (nlist)`)
   * before rebuilding.
   */
  readonly nlist?: number | "auto";
  /** Optional lock wait budget in milliseconds (`0` disables). */
  readonly lockTimeoutMs?: number;
  /** Optional statement timeout in milliseconds (`0` disables). */
  readonly statementTimeoutMs?: number;
}

interface VectorIndexStatsRow {
  readonly method: VectorIndexMethod;
  readonly index_name: string;
  readonly index_size_bytes: string;
  readonly embedded_records: string;
  readonly prism_nlist: number | null;
  readonly prism_pinned_nlist: number | null;
  readonly prism_ideal_nlist: number | null;
  readonly prism_target_pages: number | null;
  readonly prism_target_entries: number | null;
  readonly prism_nlevels: number | null;
  readonly prism_posting_pages: string | null;
  readonly prism_needs_reindex: boolean | null;
  readonly prism_reindex_reason: PrismReindexReason | null;
}

const reindexOptionsSchema = z.strictObject({
  concurrently: z.boolean().optional(),
  nlist: z.union([z.int().min(1).max(2_000_000), z.literal("auto")]).optional(),
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
    throw new NotFoundError(`${treePath}/${name}`);
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
    throw new NotFoundError(`${treePath}/${name}`);
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

export async function vectorIndexStats(
  index: Index,
): Promise<VectorIndexStats> {
  const { sql } = index;
  const [row] = await runSql(
    sql<VectorIndexStatsRow[]>`
      select
        method
      , index_name
      , index_size_bytes::text as index_size_bytes
      , embedded_records::text as embedded_records
      , prism_nlist
      , prism_pinned_nlist
      , prism_ideal_nlist
      , prism_target_pages
      , prism_target_entries
      , prism_nlevels
      , prism_posting_pages::text as prism_posting_pages
      , prism_needs_reindex
      , prism_reindex_reason
      from ${sql(index.schema)}.vector_index_stats()
    `,
    {
      spanName: "vectorIndexStats",
      dbOperationName: "SELECT",
      namespace: index.schema,
    },
  );
  if (!row) {
    throw new Error("vector_index_stats returned no rows");
  }
  const prism: PrismIndexStats | null =
    row.method === "prism" &&
    row.prism_nlist !== null &&
    row.prism_ideal_nlist !== null &&
    row.prism_target_pages !== null &&
    row.prism_target_entries !== null &&
    row.prism_nlevels !== null &&
    row.prism_posting_pages !== null &&
    row.prism_needs_reindex !== null
      ? Object.freeze({
          nlist: row.prism_nlist,
          pinnedNlist: row.prism_pinned_nlist,
          idealNlist: row.prism_ideal_nlist,
          targetPages: row.prism_target_pages,
          targetEntries: row.prism_target_entries,
          nlevels: row.prism_nlevels,
          postingPages: Number(row.prism_posting_pages),
          needsReindex: row.prism_needs_reindex,
          reindexReason: row.prism_reindex_reason,
        })
      : null;

  return Object.freeze({
    method: row.method,
    indexName: row.index_name,
    indexSizeBytes: Number(row.index_size_bytes),
    embeddedRecords: Number(row.embedded_records),
    prism,
  });
}

async function applyPrismNlistOption(
  sql: postgres.ISql,
  schema: string,
  indexName: string,
  nlist: number | "auto" | undefined,
): Promise<void> {
  if (nlist === undefined) return;
  if (nlist === "auto") {
    await runSql(
      sql`alter index ${sql(schema)}.${sql(indexName)} reset (nlist)`,
      {
        spanName: "alterVectorIndexNlist",
        dbOperationName: "ALTER",
        namespace: schema,
      },
    );
  } else {
    await runSql(
      sql`alter index ${sql(schema)}.${sql(indexName)} set (nlist = ${sql.unsafe(String(nlist))})`,
      {
        spanName: "alterVectorIndexNlist",
        dbOperationName: "ALTER",
        namespace: schema,
      },
    );
  }
}

export async function reindexVectorIndex(
  index: Index,
  options?: ReindexVectorIndexOptions,
): Promise<VectorIndexStats> {
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
    nlist,
    lockTimeoutMs,
    statementTimeoutMs,
  } = parsed.data;
  if (nlist !== undefined && index.vectorIndex !== "prism") {
    throw new InvalidInputError(
      "Invalid reindexVectorIndex options: nlist is only supported for prism vector indexes",
      {
        issues: [
          {
            code: "custom",
            message: "nlist is only supported for prism vector indexes",
            path: ["nlist"],
          },
        ],
      },
    );
  }
  const indexName = vectorIndexNameForMethod(index.vectorIndex);
  const { sql } = index;

  if (concurrently) {
    if (
      "savepoint" in sql ||
      typeof (sql as postgres.Sql).reserve !== "function"
    ) {
      throw new InvalidInputError(
        "Cannot run REINDEX INDEX CONCURRENTLY inside a transaction",
      );
    }
    if (lockTimeoutMs === undefined && statementTimeoutMs === undefined) {
      await applyPrismNlistOption(sql, index.schema, indexName, nlist);
      await runSql(
        sql`reindex index concurrently ${sql(index.schema)}.${sql(indexName)}`,
        {
          spanName: "reindexVectorIndex",
          dbOperationName: "REINDEX",
          namespace: index.schema,
        },
      );
    } else {
      const reserved = await (sql as postgres.Sql).reserve();
      let priorLockTimeout: string | undefined;
      let priorStatementTimeout: string | undefined;
      try {
        const [prior] = await runSql(
          reserved<
            {
              readonly lock_timeout: string;
              readonly statement_timeout: string;
            }[]
          >`
            select
              pg_catalog.current_setting('lock_timeout') as lock_timeout
            , pg_catalog.current_setting('statement_timeout') as statement_timeout
          `,
          {
            spanName: "readSessionTimeouts",
            dbOperationName: "SELECT",
            namespace: index.schema,
          },
        );
        priorLockTimeout = prior?.lock_timeout;
        priorStatementTimeout = prior?.statement_timeout;
        if (lockTimeoutMs !== undefined) {
          await runSql(
            reserved`select pg_catalog.set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, false)`,
            {
              spanName: "setLockTimeout",
              dbOperationName: "SET",
              namespace: index.schema,
            },
          );
        }
        if (statementTimeoutMs !== undefined) {
          await runSql(
            reserved`select pg_catalog.set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, false)`,
            {
              spanName: "setStatementTimeout",
              dbOperationName: "SET",
              namespace: index.schema,
            },
          );
        }
        await applyPrismNlistOption(reserved, index.schema, indexName, nlist);
        await runSql(
          reserved`reindex index concurrently ${reserved(index.schema)}.${reserved(indexName)}`,
          {
            spanName: "reindexVectorIndex",
            dbOperationName: "REINDEX",
            namespace: index.schema,
          },
        );
      } finally {
        try {
          if (lockTimeoutMs !== undefined && priorLockTimeout !== undefined) {
            await reserved`select pg_catalog.set_config('lock_timeout', ${priorLockTimeout}, false)`;
          }
          if (
            statementTimeoutMs !== undefined &&
            priorStatementTimeout !== undefined
          ) {
            await reserved`select pg_catalog.set_config('statement_timeout', ${priorStatementTimeout}, false)`;
          }
        } finally {
          reserved.release();
        }
      }
    }
  } else if (
    (nlist !== undefined ||
      lockTimeoutMs !== undefined ||
      statementTimeoutMs !== undefined) &&
    !("savepoint" in sql) &&
    typeof (sql as postgres.Sql).begin === "function"
  ) {
    await (sql as postgres.Sql).begin(async (tx) => {
      if (lockTimeoutMs !== undefined) {
        await runSql(
          tx`select pg_catalog.set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`,
          {
            spanName: "setLockTimeout",
            dbOperationName: "SET",
            namespace: index.schema,
          },
        );
      }
      if (statementTimeoutMs !== undefined) {
        await runSql(
          tx`select pg_catalog.set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
          {
            spanName: "setStatementTimeout",
            dbOperationName: "SET",
            namespace: index.schema,
          },
        );
      }
      await applyPrismNlistOption(tx, index.schema, indexName, nlist);
      await runSql(tx`reindex index ${tx(index.schema)}.${tx(indexName)}`, {
        spanName: "reindexVectorIndex",
        dbOperationName: "REINDEX",
        namespace: index.schema,
      });
    });
  } else {
    if (lockTimeoutMs !== undefined) {
      await runSql(
        sql`select pg_catalog.set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`,
        {
          spanName: "setLockTimeout",
          dbOperationName: "SET",
          namespace: index.schema,
        },
      );
    }
    if (statementTimeoutMs !== undefined) {
      await runSql(
        sql`select pg_catalog.set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true)`,
        {
          spanName: "setStatementTimeout",
          dbOperationName: "SET",
          namespace: index.schema,
        },
      );
    }
    await applyPrismNlistOption(sql, index.schema, indexName, nlist);
    await runSql(sql`reindex index ${sql(index.schema)}.${sql(indexName)}`, {
      spanName: "reindexVectorIndex",
      dbOperationName: "REINDEX",
      namespace: index.schema,
    });
  }

  return vectorIndexStats(index);
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
