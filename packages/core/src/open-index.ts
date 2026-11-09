import type { Attributes, Span } from "@opentelemetry/api";
import type { EmbeddingModel } from "ai";
import type postgres from "postgres";
import { z } from "zod";
import type { VectorIndexMethod } from "./config.ts";
import { SCHEMA_FORMAT_VERSION } from "./create-index.ts";
import {
  type EmbeddingFailure,
  type ListEmbeddingFailuresOptions,
  listEmbeddingFailures,
  pruneQueue,
  type QueueStats,
  queueStats,
  type RetryEmbeddingFailuresOptions,
  type RetryEmbeddingFailuresResult,
  retryEmbeddingFailures,
} from "./db/embedding-queue.ts";
import {
  getExtensionInfo,
  PRISM_EXTENSION_REQUIREMENT,
  REQUIRED_EXTENSIONS,
} from "./db/extensions.ts";
import {
  readIndexMarker,
  readIndexShape,
  readMigrationLedgerState,
} from "./db/marker.ts";
import { dropIndexSchema } from "./drop-index.ts";
import {
  type EmbeddingWorker,
  type EmbeddingWorkerOptions,
  type ProcessEmbeddingsOptions,
  type ProcessEmbeddingsResult,
  processEmbeddings,
  startEmbeddingWorker,
} from "./embedding-worker.ts";
import {
  InvalidConfigError,
  InvalidIndexError,
  SchemaVersionError,
} from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runOperation } from "./operation.ts";
import {
  deleteByName,
  deleteRecord,
  get,
  getByName,
  type PatchInput,
  patch,
  type ReindexVectorIndexOptions,
  reindexVectorIndex,
  type StoredRecord,
} from "./records.ts";
import { type SearchOptions, type SearchResult, search } from "./search.ts";
import {
  copyTree,
  countTree,
  deleteTree,
  listTree,
  moveTree,
  type TreeCountOptions,
  type TreeCountResult,
  type TreeCountSelector,
  type TreeListEntry,
  type TreeMutationOptions,
  type TreeMutationResult,
  type TreeViewOptions,
  treeView,
} from "./tree.ts";
import { noTruncation, type Truncator } from "./truncate.ts";
import { toValidationIssue } from "./validation.ts";
import {
  type UpsertOptions,
  type UpsertRecord,
  type UpsertResult,
  upsertMany,
} from "./write.ts";

/**
 * The subset of {@link Index} that is safe to compose inside one caller-owned
 * transaction: record and tree operations only. Embedding-drain and queue
 * maintenance are intentionally excluded — the worker owns multiple short
 * transactions around remote provider calls and must not run inside (or outlive)
 * a caller transaction. Obtained via {@link Index.with}.
 *
 * One method here can still leave the process: `search({ semantic })` embeds
 * the query text through the index's model *inside* your transaction, holding
 * its connection and any locks it has taken across the provider call. Prefer
 * embedding first and passing `vector` unless the model is local.
 */
export interface TransactionIndex {
  /** Insert one record, replacing a conflict by default. */
  upsert(record: UpsertRecord, options?: UpsertOptions): Promise<UpsertResult>;
  /** Insert records, replacing conflicts by default. */
  upsertMany(
    records: readonly UpsertRecord[],
    options?: UpsertOptions,
  ): Promise<readonly UpsertResult[]>;
  /** Insert one record and throw {@link ConflictError} if it already exists. */
  insert(record: UpsertRecord): Promise<UpsertResult>;
  /** Insert records and throw {@link ConflictError} if any already exist. */
  insertMany(
    records: readonly UpsertRecord[],
  ): Promise<readonly UpsertResult[]>;
  /**
   * Search within the transaction. `semantic` embeds through the model while
   * the transaction is open; prefer a precomputed `vector` here.
   */
  search(options?: SearchOptions): Promise<readonly SearchResult[]>;
  get(id: string): Promise<StoredRecord>;
  getByName(tree: string, name: string): Promise<StoredRecord>;
  patch(
    id: string,
    priorVersionHash: string,
    input: PatchInput,
  ): Promise<StoredRecord>;
  delete(id: string): Promise<void>;
  deleteByName(tree: string, name: string): Promise<void>;
  moveTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  copyTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  deleteTree(
    tree: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult>;
  countTree(
    selector: TreeCountSelector,
    options?: TreeCountOptions,
  ): Promise<TreeCountResult>;
  listTree(lquery: string): Promise<readonly TreeListEntry[]>;
  treeView(
    tree?: string,
    options?: TreeViewOptions,
  ): Promise<readonly TreeListEntry[]>;
}

/** An AI SDK `EmbeddingModel` object. Model id strings are not accepted. */
export type IndexEmbeddingModel = Exclude<EmbeddingModel, string>;

export interface OpenIndexOptions {
  /**
   * An AI SDK embedding model object (for example
   * `openai.textEmbeddingModel("text-embedding-3-small")`), or
   * {@link noEmbedding} for a handle that never generates vectors. A model id
   * string is rejected: the AI SDK resolves it through its global default
   * provider, which is the Vercel AI Gateway unless the application sets
   * another one.
   */
  readonly embedding: IndexEmbeddingModel;
  /**
   * Applied to record content (by the worker) and to `semantic` query text
   * before embedding. Runtime policy only — not persisted. Defaults to
   * {@link noTruncation}. With a prefix, the truncator gets the prefixed text,
   * so the prefix counts toward its budget. It must keep the start of the text,
   * as all built-in truncators do.
   */
  readonly truncate?: Truncator;
  /**
   * Literal text put before record content when the worker embeds it, for
   * models that need a document task prefix (for example `"search_document: "`
   * for Nomic models). Defaults to `""`. Stored content and full-text search
   * do not change. Runtime policy only: a change applies only to records
   * embedded after it, so re-embed existing records after you change it.
   */
  readonly documentPrefix?: string;
  /**
   * Literal text put before `semantic` query text when search embeds it (for
   * example `"search_query: "`). Defaults to `""`. Runtime policy only.
   */
  readonly queryPrefix?: string;
}

export class Index implements TransactionIndex {
  readonly schema: string;
  readonly vectorType: "vector" | "halfvec";
  readonly dimensions: number;
  /** Vector index access method. `prism` is experimental. */
  readonly vectorIndex: VectorIndexMethod;
  readonly embedding: IndexEmbeddingModel;
  readonly truncate: Truncator;
  /** Text put before record content for embedding. See {@link OpenIndexOptions}. */
  readonly documentPrefix: string;
  /** Text put before semantic query text for embedding. */
  readonly queryPrefix: string;

  /** @internal Caller-owned pool or transaction used by every method. */
  readonly sql: postgres.ISql;

  /** @internal Constructed by {@link openIndex} and {@link Index.with} only. */
  constructor(options: {
    sql: postgres.ISql;
    schema: string;
    vectorType: "vector" | "halfvec";
    dimensions: number;
    vectorIndex: VectorIndexMethod;
    embedding: IndexEmbeddingModel;
    truncate: Truncator;
    documentPrefix?: string;
    queryPrefix?: string;
  }) {
    this.sql = options.sql;
    this.schema = options.schema;
    this.vectorType = options.vectorType;
    this.dimensions = options.dimensions;
    this.vectorIndex = options.vectorIndex;
    this.embedding = options.embedding;
    this.truncate = options.truncate;
    this.documentPrefix = options.documentPrefix ?? "";
    this.queryPrefix = options.queryPrefix ?? "";
  }

  /** Insert one record, replacing a conflict by default. */
  async upsert(
    record: UpsertRecord,
    options?: UpsertOptions,
  ): Promise<UpsertResult> {
    return runIndexOperation(
      this,
      "searchgres.record.upsert",
      async (span) => {
        setRecordIdAttribute(span, record);
        const [result] = await upsertMany(this, [record], options);
        if (!result) {
          throw new Error(
            "Upsert result invariant failed: expected one record",
          );
        }
        span.setAttributes({
          "searchgres.record.id": result.id,
          "searchgres.result.count": 1,
        });
        return result;
      },
      { "searchgres.batch.size": 1 },
    );
  }

  /** Insert or replace up to 1,000 records in one bulk SQL statement. */
  async upsertMany(
    records: readonly UpsertRecord[],
    options?: UpsertOptions,
  ): Promise<readonly UpsertResult[]> {
    return runIndexOperation(
      this,
      "searchgres.record.upsert_many",
      async (span) => {
        const results = await upsertMany(this, records, options);
        span.setAttribute("searchgres.result.count", results.length);
        return results;
      },
      { "searchgres.batch.size": arrayLength(records) },
    );
  }

  /** Insert one record and throw {@link ConflictError} if it already exists. */
  async insert(record: UpsertRecord): Promise<UpsertResult> {
    return runIndexOperation(
      this,
      "searchgres.record.insert",
      async (span) => {
        setRecordIdAttribute(span, record);
        const [result] = await upsertMany(this, [record], {
          onConflict: "error",
        });
        if (!result) {
          throw new Error(
            "Insert result invariant failed: expected one record",
          );
        }
        span.setAttributes({
          "searchgres.record.id": result.id,
          "searchgres.result.count": 1,
        });
        return result;
      },
      { "searchgres.batch.size": 1 },
    );
  }

  /** Insert records and throw {@link ConflictError} if any already exist. */
  async insertMany(
    records: readonly UpsertRecord[],
  ): Promise<readonly UpsertResult[]> {
    return runIndexOperation(
      this,
      "searchgres.record.insert_many",
      async (span) => {
        const results = await upsertMany(this, records, {
          onConflict: "error",
        });
        span.setAttribute("searchgres.result.count", results.length);
        return results;
      },
      { "searchgres.batch.size": arrayLength(records) },
    );
  }

  /**
   * Search the index. The retrieval mode is inferred from the supplied arms:
   * `semantic`/`vector` only, `fulltext` only, both (hybrid RRF), or neither
   * (filter-only listing).
   */
  async search(options?: SearchOptions): Promise<readonly SearchResult[]> {
    return runIndexOperation(this, "searchgres.search", (span) =>
      search(this, options ?? {}, span),
    );
  }

  /** Read one record by id. Throws `NotFoundError` when it does not exist. */
  async get(id: string): Promise<StoredRecord> {
    return runIndexOperation(
      this,
      "searchgres.record.get",
      async (span) => {
        const record = await get(this, id);
        span.setAttributes({
          "searchgres.record.id": record.id,
          "searchgres.result.count": 1,
        });
        return record;
      },
      validRecordIdAttribute(id),
    );
  }

  /** Read one record by its `(tree, name)` address. Throws `NotFoundError`. */
  async getByName(tree: string, name: string): Promise<StoredRecord> {
    return runIndexOperation(
      this,
      "searchgres.record.get_by_name",
      async (span) => {
        const record = await getByName(this, tree, name);
        span.setAttributes({
          "searchgres.record.id": record.id,
          "searchgres.result.count": 1,
        });
        return record;
      },
    );
  }

  /**
   * Optimistically update a record. `priorVersionHash` must match the current
   * row: a missing row throws `NotFoundError`, a changed row `StaleVersionError`.
   * Returns the updated record.
   */
  async patch(
    id: string,
    priorVersionHash: string,
    input: PatchInput,
  ): Promise<StoredRecord> {
    return runIndexOperation(
      this,
      "searchgres.record.patch",
      async (span) => {
        const record = await patch(this, id, priorVersionHash, input);
        span.setAttributes({
          "searchgres.record.id": record.id,
          "searchgres.result.count": 1,
        });
        return record;
      },
      validRecordIdAttribute(id),
    );
  }

  /** Delete one record by id. Throws `NotFoundError` when it does not exist. */
  async delete(id: string): Promise<void> {
    return runIndexOperation(
      this,
      "searchgres.record.delete",
      async (span) => {
        await deleteRecord(this, id);
        span.setAttribute("searchgres.record.id", id);
      },
      validRecordIdAttribute(id),
    );
  }

  /** Delete one record by its `(tree, name)` address. Throws `NotFoundError`. */
  async deleteByName(tree: string, name: string): Promise<void> {
    return runIndexOperation(this, "searchgres.record.delete_by_name", () =>
      deleteByName(this, tree, name),
    );
  }

  /** Move a subtree: rewrite the `source` prefix to `destination`. */
  async moveTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return runTreeOperation(this, "searchgres.tree.move", options, () =>
      moveTree(this, source, destination, options),
    );
  }

  /** Copy a subtree under `destination` as fresh records. */
  async copyTree(
    source: string,
    destination: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return runTreeOperation(this, "searchgres.tree.copy", options, () =>
      copyTree(this, source, destination, options),
    );
  }

  /** Delete an inclusive subtree. */
  async deleteTree(
    tree: string,
    options?: TreeMutationOptions,
  ): Promise<TreeMutationResult> {
    return runTreeOperation(this, "searchgres.tree.delete", options, () =>
      deleteTree(this, tree, options),
    );
  }

  /** Count records matching one explicit tree filter kind. */
  async countTree(
    selector: TreeCountSelector,
    options?: TreeCountOptions,
  ): Promise<TreeCountResult> {
    return runIndexOperation(this, "searchgres.tree.count", async (span) => {
      const result = await countTree(this, selector, options);
      span.setAttribute("searchgres.result.count", result.count);
      return result;
    });
  }

  /** List the tree nodes matching an lquery with per-node descendant counts. */
  async listTree(lquery: string): Promise<readonly TreeListEntry[]> {
    return runIndexOperation(this, "searchgres.tree.list", async (span) => {
      const results = await listTree(this, lquery);
      span.setAttribute("searchgres.result.count", results.length);
      return results;
    });
  }

  /**
   * Inclusive display tree rooted at `tree` (default: the whole index) with
   * per-node descendant counts. Unlike `listTree`, the root itself is
   * included; `options.levels` bounds the relative depth.
   */
  async treeView(
    tree?: string,
    options?: TreeViewOptions,
  ): Promise<readonly TreeListEntry[]> {
    return runIndexOperation(this, "searchgres.tree.view", async (span) => {
      const results = await treeView(this, tree, options);
      span.setAttribute("searchgres.result.count", results.length);
      return results;
    });
  }

  /**
   * Drain pending embedding work in one bounded pass and return the outcome.
   * For cron, post-bulk-ingest, or a serverless invocation. Concurrency-safe
   * with other drainers via `for update skip locked`.
   */
  async processEmbeddings(
    options?: ProcessEmbeddingsOptions,
  ): Promise<ProcessEmbeddingsResult> {
    return runIndexOperation(this, "searchgres.embedding.process", (span) =>
      processEmbeddings(this, options, span),
    );
  }

  /**
   * Start a continuous background drainer. Returns a handle whose `stop()`
   * finishes the in-flight batch and halts; it never closes the caller's pool.
   */
  startEmbeddingWorker(options?: EmbeddingWorkerOptions): EmbeddingWorker {
    return startEmbeddingWorker(this, options);
  }

  /** Aggregate embedding-queue snapshot for operational visibility. */
  async queueStats(): Promise<QueueStats> {
    return runIndexOperation(
      this,
      "searchgres.embedding.queue.stats",
      async (span) => {
        const stats = await queueStats(this.sql, this.schema);
        span.setAttributes({
          "searchgres.embedding.pending": stats.pending,
          "searchgres.embedding.in_flight": stats.inFlight,
          "searchgres.embedding.waiting": stats.waiting,
          "searchgres.embedding.failed": stats.failed,
        });
        return stats;
      },
    );
  }

  /** List current unresolved terminal embedding failures by ascending queue id. */
  async listEmbeddingFailures(
    options?: ListEmbeddingFailuresOptions,
  ): Promise<readonly EmbeddingFailure[]> {
    return runIndexOperation(
      this,
      "searchgres.embedding.failure.list",
      async (span) => {
        const failures = await listEmbeddingFailures(
          this.sql,
          this.schema,
          options,
        );
        span.setAttribute("searchgres.result.count", failures.length);
        return failures;
      },
    );
  }

  /** Reset selected current terminal failures to immediately pending work. */
  async retryEmbeddingFailures(
    options: RetryEmbeddingFailuresOptions,
  ): Promise<RetryEmbeddingFailuresResult> {
    return runIndexOperation(
      this,
      "searchgres.embedding.failure.retry",
      async (span) => {
        span.setAttribute(
          "searchgres.batch.size",
          Array.isArray(options?.queueIds) ? options.queueIds.length : 0,
        );
        const result = await retryEmbeddingFailures(
          this.sql,
          this.schema,
          options,
        );
        span.setAttributes({
          "searchgres.embedding.retried": result.retried,
          "searchgres.embedding.skipped": result.skipped,
        });
        return result;
      },
    );
  }

  /** Delete terminal queue rows older than `retentionMs`. Returns rows removed. */
  async pruneEmbeddingQueue(options: {
    readonly retentionMs: number;
  }): Promise<number> {
    return runIndexOperation(
      this,
      "searchgres.embedding.queue.prune",
      async (span) => {
        const count = await pruneQueue(
          this.sql,
          this.schema,
          options.retentionMs,
        );
        span.setAttribute("searchgres.result.count", count);
        return count;
      },
    );
  }

  /**
   * Rebuild the vector index (`REINDEX INDEX [CONCURRENTLY]`). For `prism`,
   * run `ANALYZE` on the record table first, so the rebuild sizes its clusters
   * from the current row count.
   */
  async reindexVectorIndex(options?: ReindexVectorIndexOptions): Promise<void> {
    return runIndexOperation(
      this,
      "searchgres.index.vector_reindex",
      async (span) => {
        span.setAttributes({
          "searchgres.index.vector_method": this.vectorIndex,
          "searchgres.index.concurrently": options?.concurrently ?? false,
        });
        await reindexVectorIndex(this, options);
      },
    );
  }

  /**
   * Bind record/tree operations to a caller-owned transaction so they compose
   * atomically. A no-I/O clone; the caller owns commit/rollback and the pool.
   * Embedding-drain and queue methods are intentionally not exposed here, and
   * `search({ semantic })` on the returned handle calls the embedding model
   * with the transaction open — embed first and pass `vector` instead.
   */
  with(tx: postgres.TransactionSql): TransactionIndex {
    return new Index({
      sql: tx,
      schema: this.schema,
      vectorType: this.vectorType,
      dimensions: this.dimensions,
      vectorIndex: this.vectorIndex,
      embedding: this.embedding,
      truncate: this.truncate,
      documentPrefix: this.documentPrefix,
      queryPrefix: this.queryPrefix,
    });
  }

  /** Drop this index's schema and everything in it (`drop schema … cascade`). */
  async drop(): Promise<void> {
    return runIndexOperation(this, "searchgres.index.drop", () =>
      dropIndexSchema(this.sql, this.schema),
    );
  }
}

function runIndexOperation<T>(
  index: Pick<Index, "schema">,
  name: string,
  callback: (span: Span) => Promise<T>,
  attributes?: Attributes,
): Promise<T> {
  return runOperation(
    name,
    {
      schema: index.schema,
      ...(attributes === undefined ? {} : { attributes }),
    },
    callback,
  );
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function setRecordIdAttribute(span: Span, record: unknown): void {
  if (typeof record !== "object" || record === null || !("id" in record)) {
    return;
  }
  span.setAttributes(
    validRecordIdAttribute((record as { readonly id?: unknown }).id),
  );
}

function validRecordIdAttribute(id: unknown): Attributes {
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      id,
    )
    ? { "searchgres.record.id": id }
    : {};
}

function runTreeOperation(
  index: Index,
  name: string,
  options: TreeMutationOptions | undefined,
  callback: () => Promise<TreeMutationResult>,
): Promise<TreeMutationResult> {
  return runIndexOperation(index, name, async (span) => {
    span.setAttribute("searchgres.tree.dry_run", options?.dryRun ?? false);
    const result = await callback();
    span.setAttribute("searchgres.result.count", result.count);
    return result;
  });
}

/**
 * Shape check only. A model is any object with `doEmbed` (the one member every
 * `EmbeddingModelV*` spec shares). A model id string is rejected, because the
 * AI SDK resolves it through its global default provider (the Vercel AI
 * Gateway by default), which is a silent third-party data path. Model identity
 * and dimensions are deliberately not probed here; the embedding column typmod
 * is enforced at write-back (`DimensionMismatchError`).
 */
const openIndexOptionsSchema = z.strictObject({
  embedding: z.custom<IndexEmbeddingModel>(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { doEmbed?: unknown }).doEmbed === "function",
    {
      error: (issue) =>
        typeof issue.input === "string"
          ? "expected an AI SDK embedding model object, not a model id string (the AI SDK sends a model id string to its global default provider, which is the Vercel AI Gateway unless you set another one). Pass a provider model, for example openai.textEmbeddingModel(...), or noEmbedding"
          : "expected an AI SDK embedding model object (with doEmbed), or noEmbedding",
    },
  ),
  truncate: z
    .custom<Truncator>((value) => typeof value === "function", {
      error: "expected a Truncator function",
    })
    .optional(),
  documentPrefix: z.string().optional(),
  queryPrefix: z.string().optional(),
});

function normalizeOpenIndexOptions(input: unknown): OpenIndexOptions {
  const result = openIndexOptionsSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "options"}: ${first.message}`
      : "validation failed";
    throw new InvalidConfigError(`Invalid openIndex options: ${detail}`, {
      cause: result.error,
      issues,
    });
  }
  return result.data as OpenIndexOptions;
}

/** Open and validate a searchgres index without running DDL. */
export async function openIndex(
  sql: postgres.Sql,
  schema: string,
  options: OpenIndexOptions,
): Promise<Index> {
  return runOperation("searchgres.index.open", { schema }, async (span) => {
    const index = await openIndexHandle(sql, schema, options);
    span.setAttributes({
      "searchgres.index.vector_type": index.vectorType,
      "searchgres.index.dimensions": index.dimensions,
    });
    return index;
  });
}

async function openIndexHandle(
  sql: postgres.Sql,
  schema: string,
  options: OpenIndexOptions,
): Promise<Index> {
  const indexSchema = assertSchemaName(schema);
  const opts = normalizeOpenIndexOptions(options);
  const version = await readIndexMarker(sql, indexSchema);
  if (version !== SCHEMA_FORMAT_VERSION) {
    throw new SchemaVersionError(indexSchema, version, SCHEMA_FORMAT_VERSION);
  }
  const ledger = await readMigrationLedgerState(sql, indexSchema);
  if (!ledger.validTable) {
    throw new InvalidIndexError(indexSchema, {
      detail: `missing or invalid migration table for schema format ${version}`,
    });
  }

  // searchgres is public-only: every required extension must be installed in
  // `public`, and the index objects must resolve to it.
  for (const requirement of REQUIRED_EXTENSIONS) {
    await getExtensionInfo(sql, requirement);
  }

  const vectorShape = await readIndexShape(sql, indexSchema);
  if (vectorShape.vectorIndex === "prism") {
    await getExtensionInfo(sql, PRISM_EXTENSION_REQUIREMENT);
  }

  return new Index({
    sql,
    schema: indexSchema,
    vectorType: vectorShape.vectorType,
    dimensions: vectorShape.dimensions,
    vectorIndex: vectorShape.vectorIndex,
    embedding: opts.embedding,
    truncate: opts.truncate ?? noTruncation,
    ...(opts.documentPrefix === undefined
      ? {}
      : { documentPrefix: opts.documentPrefix }),
    ...(opts.queryPrefix === undefined
      ? {}
      : { queryPrefix: opts.queryPrefix }),
  });
}
