import type postgres from "postgres";
import { z } from "zod";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  InvalidInputError,
  SearchgresError,
  type ValidationIssue,
} from "./errors.ts";
import { isValidTreePath } from "./identifiers.ts";
import type { Index } from "./open-index.ts";
import { mapInputSqlError, postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import { normalizeTemporalTuple, temporalTupleSchema } from "./temporal.ts";
import { metaSchema, toValidationIssue } from "./validation.ts";

const MAX_UPSERT_BATCH_SIZE = 1000;

const recordSchema = z
  .object({
    id: z.uuidv7({ error: "expected a UUIDv7" }).optional(),
    // Empty content can never be embedded (providers reject it), so it would
    // only burn attempts and land in `failed`; reject it at the boundary.
    content: z.string().min(1, "content must not be empty"),
    meta: metaSchema.default({}),
    tree: z
      .string()
      .refine(
        isValidTreePath,
        "expected a dotted ltree path (or the empty root)",
      )
      .default(""),
    temporal: temporalTupleSchema.optional(),
    name: z
      .string()
      .min(1, "name must not be empty; use null for an unnamed record")
      .nullable()
      .default(null),
    embedding: z.array(z.number().finite()).readonly().optional(),
  })
  .strict();

const upsertOptionsSchema = z
  .object({
    onConflict: z.enum(["error", "ignore", "replace"]).default("replace"),
  })
  .strict()
  .default({ onConflict: "replace" });

/** One record to insert or replace. */
export type UpsertRecord = z.input<typeof recordSchema>;
/** Conflict behavior for {@link Index.upsert} and {@link Index.upsertMany}. */
export type UpsertOptions = z.input<typeof upsertOptionsSchema>;
/** The outcome for one input record. */
export interface UpsertResult {
  readonly id: string;
  readonly status: "inserted" | "updated" | "skipped";
}

interface BatchUpsertRow {
  readonly ord: string;
  readonly id: string | null;
  readonly status: "inserted" | "updated" | "skipped";
}

/**
 * Validate a batch of records and write them through the schema-local
 * `batch_upsert` routine, which owns the full conflict contract in one call.
 */
export async function upsertMany(
  index: Index,
  records: readonly UpsertRecord[],
  options?: UpsertOptions,
): Promise<readonly UpsertResult[]> {
  if (records.length > MAX_UPSERT_BATCH_SIZE) {
    throw new BatchTooLargeError(records.length, MAX_UPSERT_BATCH_SIZE);
  }

  const parsedOptions = parseOptions(options);
  const ids: Array<string | null> = [];
  const contents: string[] = [];
  const metas: Array<z.output<typeof recordSchema>["meta"]> = [];
  const trees: string[] = [];
  const temporals: Array<string | null> = [];
  const names: Array<string | null> = [];
  const embeddings: Array<string | null> = [];
  const explicitIds = new Set<string>();
  const namedKeys = new Set<string>();

  for (let position = 0; position < records.length; position++) {
    const parsed = recordSchema.safeParse(records[position]);
    if (!parsed.success) {
      const [issue] = parsed.error.issues;
      const mapped = issue
        ? toValidationIssue(issue)
        : { code: "custom", message: "validation failed", path: [] };
      throwInvalidRecordInput(
        [{ ...mapped, path: [position, ...mapped.path] }],
        parsed.error,
      );
    }

    const record = parsed.data;
    if (record.embedding && record.embedding.length !== index.dimensions) {
      throw new DimensionMismatchError(
        index.dimensions,
        record.embedding.length,
        { position },
      );
    }
    const id = record.id ?? null;
    const name = record.name;
    // Fail fast before the round trip. `batch_upsert` enforces both rules too and
    // is authoritative (its body is part of the immutable schema format), so keep
    // these checks in sync with it rather than treating either side as the truth.
    if (id !== null) {
      // PostgreSQL `uuid` equality is case-insensitive, so compare on the
      // lowercased form; `ids` keeps the caller's spelling for the write.
      const key = id.toLowerCase();
      if (explicitIds.has(key)) {
        throw duplicateKeyError("duplicate explicit id within batch", position);
      }
      explicitIds.add(key);
    }
    if (name !== null) {
      const key = `${record.tree}\0${name}`;
      if (namedKeys.has(key)) {
        throw duplicateKeyError(
          "duplicate (tree, name) within batch",
          position,
        );
      }
      namedKeys.add(key);
    }

    ids.push(id);
    contents.push(record.content);
    metas.push(record.meta);
    trees.push(record.tree);
    temporals.push(
      record.temporal ? normalizeTemporalTuple(record.temporal) : null,
    );
    names.push(name);
    embeddings.push(encodeEmbedding(record.embedding));
  }
  if (ids.length === 0) return [];

  const { sql } = index;
  // postgres.js 3 learns array types when each connection starts. If
  // createIndex installs extension types on that same connection, it does not
  // know ltree[] or vector[], and it sends a bare array to such a parameter as
  // "a,b". Each array parameter has a literal ::text[] cast, so the server
  // describes it as the built-in text[] type, which postgres.js 3 and 4 both
  // encode correctly. PostgreSQL then casts the elements to the routine's
  // qualified destination type. postgres.js owns array escaping, nulls, and
  // empty arrays; values remain parameters. Do not interpolate the cast, and do
  // not bind an array directly to an extension array type.
  const embeddingArray =
    index.vectorType === "halfvec"
      ? sql`${embeddings}::text[]::public.halfvec[]`
      : sql`${embeddings}::text[]::public.vector[]`;
  const rows = await runBatchUpsert(
    sql<BatchUpsertRow[]>`
      select ord, id, status
      from ${sql(index.schema)}.batch_upsert
      ( ${ids}::text[]::uuid[]
      , ${contents}::text[]
      , ${sql.json(metas)}
      , ${trees}::text[]::public.ltree[]
      , ${temporals}::text[]::tstzrange[]
      , ${names}::text[]
      , ${embeddingArray}
      , ${parsedOptions.onConflict}
      )
    `,
    index.schema,
  );

  // `ord` mirrors the routine's 1-based `with ordinality` position, so each
  // outcome lands on its input index instead of relying on the row order.
  const results = new Array<UpsertResult>(records.length);
  let resolved = 0;
  for (const row of rows) {
    if (!row.id) {
      throw new ConflictError(
        "A conflicting named record disappeared before its result could be resolved",
      );
    }
    const position = Number(row.ord) - 1;
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position >= results.length ||
      results[position] !== undefined
    ) {
      throw new Error(
        `Upsert result invariant failed: unexpected position ${row.ord}`,
      );
    }
    results[position] = { id: row.id, status: row.status };
    resolved++;
  }
  if (resolved !== results.length) {
    throw new Error(
      `Upsert result invariant failed: expected ${results.length} results, received ${resolved}`,
    );
  }
  return results;
}

async function runBatchUpsert(
  query: postgres.PendingQuery<BatchUpsertRow[]>,
  schema: string,
): Promise<readonly BatchUpsertRow[]> {
  try {
    return await runSql(query, {
      spanName: "batchUpsert",
      dbOperationName: "SELECT",
      namespace: schema,
    });
  } catch (error) {
    // `runSql` already mapped the context-free SQLSTATEs to typed errors; those
    // carry a searchgres `code`, so never re-inspect them as a SQLSTATE.
    if (error instanceof SearchgresError) {
      throw error;
    }
    const code = postgresErrorCode(error);
    if (code === "23505") {
      throw new ConflictError(
        "One or more records conflict with existing records",
        { cause: error },
      );
    }
    throw mapInputSqlError(error, "record input") ?? error;
  }
}

function parseOptions(
  options: UpsertOptions | undefined,
): z.output<typeof upsertOptionsSchema> {
  const result = upsertOptionsSchema.safeParse(options);
  if (!result.success) {
    const [issue] = result.error.issues;
    const mapped = issue
      ? toValidationIssue(issue)
      : { code: "custom", message: "validation failed", path: [] };
    throwInvalidRecordInput([mapped], result.error);
  }
  return result.data;
}

function throwInvalidRecordInput(
  issues: readonly ValidationIssue[],
  cause?: z.ZodError,
): never {
  const first = issues[0];
  const detail = first
    ? `${first.path.join(".") || "record"}: ${first.message}`
    : "validation failed";
  throw new InvalidInputError(`Invalid record input: ${detail}`, {
    cause,
    issues,
  });
}

function duplicateKeyError(
  message: string,
  position: number,
): InvalidInputError {
  return new InvalidInputError(
    `Invalid record input: ${position}: ${message}`,
    {
      issues: [{ code: "custom", message, path: [position] }],
    },
  );
}

function encodeEmbedding(
  embedding: readonly number[] | undefined,
): string | null {
  return embedding === undefined ? null : JSON.stringify(embedding);
}
