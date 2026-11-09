# API reference

A compact reference for the public API. Each section links to the guide that
explains it in context.

Import everything from the package root:

```ts
import {
  ensureExtensions,
  createIndex,
  migrateIndex,
  openIndex,
  dropIndex,
  truncateCharacters,
  truncateBytes,
  truncateTokens,
  noTruncation,
  noEmbedding,
} from "searchgres";
```

## Factory functions

### `ensureExtensions(sql, options?) → Promise<readonly ExtensionInfo[]>`

Installs or verifies the required PostgreSQL extensions (`vector`,
`pg_textsearch`, `ltree`, and `pg_vectorsearch` when `vectorIndex: "prism"`) in
`public` under a database-wide advisory lock. Accepts `vectorIndex`,
`lockTimeoutMs`, and `transactionTimeoutMs`.

```ts
await ensureExtensions(sql);
```

### `createIndex(sql, schema, config, options?)`

Creates a new index schema after verifying that the required extensions exist in
`public`. Atomic; throws [`ConflictError`](errors.md) if the schema already
exists, [`ExtensionError`](errors.md) if a required extension is missing or not
in `public`, and [`InvalidConfigError`](errors.md) for a bad config, schema
name, or option. See [Create and manage indexes](../guides/indexes.md).

```ts
await createIndex(sql, "docs_index", {
  dimensions: 1536,        // required; must match your model
  vectorType: "halfvec",   // "halfvec" (default) | "vector"
  bm25: { textConfig: "english", k1: 1.2, b: 0.75 },
  vectorIndex: { method: "hnsw", m: 16, efConstruction: 64 },
});
```

| Config field | Default | Notes |
| --- | --- | --- |
| `dimensions` | — (required) | `hnsw`: 1–4000 for `halfvec`, 1–2000 for `vector`. `prism`: 1–1968 for both. |
| `vectorType` | `"halfvec"` | `"halfvec"` or `"vector"`; cosine distance either way. |
| `bm25.textConfig` | `"english"` | Must name an installed text search config. |
| `bm25.k1` | `1.2` | 0.1–10. |
| `bm25.b` | `0.75` | 0–1. |
| `vectorIndex` | `{ method: "hnsw", m: 16, efConstruction: 64 }` | Discriminated union on `method: "hnsw" \| "prism"`. `hnsw` accepts `m` (2–100) and `efConstruction` (4–1000). `prism` is **experimental** (pg_vectorsearch is not GA; the option can change or be removed in a minor release) and accepts optional `nlist` (1–2,000,000) and `targetPages` (1–64). |

The optional fourth argument sets runtime budgets for the call itself. Nothing
in it is persisted or affects the resulting index.

| Option | Default | Notes |
| --- | --- | --- |
| `lockTimeoutMs` | `30000` | How long to wait for the per-schema lock that serializes concurrent `createIndex` and `migrateIndex` calls targeting the same schema before throwing [`LockTimeoutError`](errors.md#database-timeouts). `0` waits indefinitely. |
| `transactionTimeoutMs` | `1200000` (20 min) | Budget for the whole provisioning transaction before throwing [`TransactionTimeoutError`](errors.md#database-timeouts). `0` disables the limit. |

### `migrateIndex(sql, schema, options?) → Promise<MigrateIndexResult>`

Explicitly migrates an existing index schema in place to the current schema
format (`3`). Accepts schema format `2` (adopting it without replaying initial
table/index creation) and `3` (applying any unapplied incremental steps and
refreshing repeatable functions and triggers). Rejects format `1` and newer
formats with [`SchemaVersionError`](errors.md), and rejects missing or
unexpected migration ledger tables with [`InvalidIndexError`](errors.md).
Requires the calling database role to be the index schema owner
(`n.nspowner = pg_catalog.to_regrole(current_user)::oid`, raising PostgreSQL
`insufficient_privilege` `42501` otherwise; use `SET ROLE` if the owner is a
`NOLOGIN` role). Needs no embedding model.

```ts
const result = await migrateIndex(sql, "docs_index", {
  lockTimeoutMs: 30_000,
  transactionTimeoutMs: 1_200_000,
});
// { schema: "docs_index", fromVersion: "2", toVersion: "3", applied: [] }
```

`result.applied` lists only incremental migrations that were executed during the
call (for a format-`2` adoption into format `3`, `001_initial` is recorded as
already present, so `applied` is `[]`).

Accepts the same `lockTimeoutMs` and `transactionTimeoutMs` budget options as
`createIndex`.

### `openIndex(sql, schema, options) → Promise<Index>`

Opens an existing index and returns a handle.

```ts
const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
  truncate: truncateCharacters(24_000), // optional
});
```

| Option | Required | Notes |
| --- | --- | --- |
| `embedding` | yes | An AI SDK embedding model object (for example `openai.embedding("text-embedding-3-small")`), or [`noEmbedding`](#noembedding) for a handle that never generates vectors. A model id string is rejected with `InvalidConfigError`: the AI SDK sends a model id string to its global default provider, which is the Vercel AI Gateway unless the application sets another one. To use the gateway, pass its model object explicitly. |
| `truncate` | no | A `Truncator`; defaults to `noTruncation`. |

Options are validated before any database access; an invalid or missing option
throws [`InvalidConfigError`](errors.md). Unknown keys are rejected. Otherwise
throws [`InvalidIndexError`](errors.md), [`SchemaVersionError`](errors.md), or
[`ExtensionError`](errors.md).

### `dropIndex(sql, schema) → Promise<void>`

Drops a searchgres.js index schema (`DROP SCHEMA ... CASCADE`) after verifying it is
one. Also available as `index.drop()`.

## The `Index` handle

Obtain a handle from `openIndex()`. Read-only properties: `schema`,
`vectorType`, `dimensions`, `vectorIndex`, `embedding`, `truncate`.

### Writing

| Method | Returns | Guide |
| --- | --- | --- |
| `upsert(record, options?)` | `UpsertResult` | Replaces conflicts by default. [Ingest](../guides/ingest.md) |
| `upsertMany(records, options?)` | `readonly UpsertResult[]` | Replaces conflicts by default. [Ingest](../guides/ingest.md) |
| `insert(record)` | `UpsertResult` | Throws `ConflictError` on a conflict. [Ingest](../guides/ingest.md) |
| `insertMany(records)` | `readonly UpsertResult[]` | Throws `ConflictError` on any conflict. [Ingest](../guides/ingest.md) |

```ts
type UpsertRecord = {
  content: string;                     // non-empty
  tree?: string;
  name?: string | null;                // non-empty; null (default) = unnamed
  meta?: Record<string, unknown>;
  temporal?: readonly [Date | string] | readonly [Date | string, Date | string];
  id?: string;                         // UUIDv7; generated when omitted
  embedding?: readonly number[];
};

type UpsertOptions = { onConflict?: "error" | "ignore" | "replace" };

type UpsertResult = { id: string; status: "inserted" | "updated" | "skipped" };
```

`upsertMany` accepts at most 1,000 records ([`BatchTooLargeError`](errors.md)
above that).

Record ids are UUIDv7 everywhere: generated ids are v7, a supplied `id` must be
v7, and the table enforces it for direct SQL too. Every method that takes an
`id` (including the `after`/`before` cursors) rejects any other UUID version
with `InvalidInputError`. v7 keeps the primary key time-ordered, which is what
makes the filter-only cursor a chronological walk.

### Reading

| Method | Returns | Notes |
| --- | --- | --- |
| `get(id)` | `StoredRecord` | Throws `NotFoundError`. |
| `getByName(tree, name)` | `StoredRecord` | Throws `NotFoundError`. |
| `patch(id, priorVersionHash, input)` | `StoredRecord` | Throws `NotFoundError` / `StaleVersionError`. |
| `delete(id)` | `void` | Throws `NotFoundError`. |
| `deleteByName(tree, name)` | `void` | Throws `NotFoundError`. |

```ts
type StoredRecord = {
  id: string;
  content: string;
  meta: Record<string, unknown>;
  tree: string;
  temporal: string | null;
  name: string | null;
  hasEmbedding: boolean;
  version: string;
  versionHash: string;
  createdAt: Date;
  // Last content/tree/name/meta/temporal change; null until the first update.
  // Embedding-only maintenance does not advance it.
  updatedAt: Date | null;
};

type PatchInput = {
  content?: string;                    // non-empty
  meta?: Record<string, unknown>;
  tree?: string;
  name?: string | null;                // non-empty; null clears the name
  temporal?: (readonly [Date | string] | readonly [Date | string, Date | string]) | null;
  embedding?: readonly number[];
};
```

See [Manage records and trees](../guides/records-and-trees.md).

### Searching

`search(options?) → Promise<readonly SearchResult[]>`. See
[Search and filter](../guides/search.md). Throws
[`InvalidInputError`](errors.md) for bad options or filters, including an
`lquery`/`ltxtquery`/`regexp`/`metaPredicate` pattern PostgreSQL rejects.

```ts
type SearchOptions = {
  // arms — semantic and vector are mutually exclusive
  semantic?: string;
  vector?: readonly number[];
  fulltext?: string;

  filter?: Filter;

  // ranking
  limit?: number;              // default 10
  semanticThreshold?: number;  // 0–1, semantic/hybrid
  k?: number;                  // hybrid, default 60
  candidateLimit?: number;     // hybrid, default 30
  fulltextWeight?: number;     // hybrid, 0–1, default 1
  semanticWeight?: number;     // hybrid, 0–1, default 1

  // filter-only listing
  order?: "asc" | "desc";
  after?: string;              // record id (UUIDv7) to continue past
  before?: string;             // record id (UUIDv7) to stop before
};

type Filter =
  | { and: readonly Filter[] }        // ≥ 2 children
  | { or: readonly Filter[] }         // ≥ 2 children
  | { not: Filter }
  | { tree: string }
  | { lquery: string }
  | { ltxtquery: string }
  | { meta: Record<string, unknown> }
  | { metaPredicate: string }
  | { temporalWithin: readonly [Date | string, Date | string] }
  | { temporalOverlaps: readonly [Date | string, Date | string] }
  | { temporalBefore: Date | string }
  | { temporalAfter: Date | string }
  | { temporalContains: Date | string }
  | { regexp: string };
```

Search option contracts:

| Option | Contract |
| --- | --- |
| `semantic` | Non-empty text. Mutually exclusive with `vector`; requires a real embedding model. |
| `vector` | Exactly `index.dimensions` finite numbers. Mutually exclusive with `semantic`. A wrong length throws [`DimensionMismatchError`](errors.md). |
| `fulltext` | Non-empty text. |
| `limit` | Integer from 1 to 1,000; default 10. |
| `semanticThreshold` | Finite number from 0 to 1; requires a `semantic` or `vector` arm. |
| `k` | Nonnegative finite number; hybrid only; default 60. |
| `candidateLimit` | Integer from 1 to 1,000; hybrid only; default 30. The effective value is raised to at least `limit`. |
| `fulltextWeight`, `semanticWeight` | Finite numbers from 0 to 1; hybrid only; each defaults to 1. |
| `order` | `"asc"` or `"desc"`; filter-only; default `"desc"`. |
| `after`, `before` | UUIDv7 cursors for filter-only listing. They are mutually exclusive. |

Supplying a mode-specific option outside its applicable mode, an unknown key, or
an out-of-range value throws [`InvalidInputError`](errors.md). A semantic
provider failure, unavailable model, or wrong vector dimension retains its more
specific embedding error class.

### Tree operations

| Method | Returns | Notes |
| --- | --- | --- |
| `moveTree(source, destination, options?)` | `{ count }` | `options.dryRun` previews. |
| `copyTree(source, destination, options?)` | `{ count }` | Fresh ids; conflicts throw `ConflictError`. |
| `deleteTree(tree, options?)` | `{ count }` | Inclusive subtree. |
| `countTree(selector, options?)` | `{ count, capped }` | Selector: one of `tree`/`lquery`/`ltxtquery`; `options.limit` caps. Malformed patterns throw `InvalidInputError`. |
| `listTree(lquery)` | `readonly { tree, count }[]` | Descendant counts per node. A malformed `lquery` throws `InvalidInputError`. |
| `treeView(tree?, options?)` | `readonly { tree, count }[]` | Inclusive display tree rooted at `tree` (default: the whole index), with per-node descendant counts. `options.levels` bounds relative depth; a negative or non-integer value throws `InvalidInputError`. |

### Embeddings

| Method | Returns | Guide |
| --- | --- | --- |
| `processEmbeddings(options?)` | `ProcessEmbeddingsResult` | [Embeddings](../guides/embeddings.md) |
| `startEmbeddingWorker(options?)` | `EmbeddingWorker` | [Embeddings](../guides/embeddings.md) |
| `queueStats()` | `QueueStats` | [Embeddings](../guides/embeddings.md) |
| `listEmbeddingFailures(options?)` | `readonly EmbeddingFailure[]` | Current unresolved terminal failures, keyset-paginated by queue id. |
| `retryEmbeddingFailures(options)` | `RetryEmbeddingFailuresResult` | Version-guarded reset of selected failures to pending work. |
| `pruneEmbeddingQueue({ retentionMs })` | `number` | [Embeddings](../guides/embeddings.md) |

```ts
type ProcessEmbeddingsOptions = {
  batchSize?: number;
  maxBatches?: number;
  maxDurationMs?: number;
  leaseDurationMs?: number;  // default 300000
  maxAttempts?: number;      // default 3
  signal?: AbortSignal;
};

type ProcessEmbeddingsResult = {
  claimed: number;
  embedded: number;
  failed: number;
  cancelled: number;
  remaining: number;
  sampleError: Error | null;  // first failure in this pass; may contain provider text
};

type EmbeddingWorkerOptions = {
  intervalMs?: number;        // default 1000
  batchSize?: number;
  leaseDurationMs?: number;   // default 300000
  maxAttempts?: number;       // default 3
  pruneRetentionMs?: number;  // default 604800000
  onError?: (error: unknown, context: WorkerErrorContext) => void;
};

type WorkerErrorContext = {
  phase: "process" | "prune";
  consecutiveErrors: number;  // failed passes in a row; rate limits excluded
  backoffMs: number;          // sleep before the next attempt
  stopped: boolean;           // true after DimensionMismatchError: no more claims
};

type EmbeddingWorker = { stop(): Promise<void> };

type QueueStats = {
  pending: number;
  inFlight: number;
  waiting: number;
  // Current record versions that exhausted attempts and still lack a vector.
  failed: number;
  oldestPendingAt: Date | null;
};

type ListEmbeddingFailuresOptions = {
  limit?: number;  // default 100, maximum 1000
  after?: string;  // queueId from the previous page
};

type EmbeddingFailure = {
  queueId: string;           // PostgreSQL bigint represented without precision loss
  recordId: string;
  contentVersion: number;
  attempts: number;
  lastError: string | null;
  enqueuedAt: Date;
  failedAt: Date;
};

type RetryEmbeddingFailuresOptions = {
  queueIds: readonly string[]; // 1–1000 unique ids
};

type RetryEmbeddingFailuresResult = {
  retried: number;
  skipped: number; // stale, resolved, pruned, already retried, or unknown
};
```

Numeric worker tuning is not currently runtime-validated as a group. Use finite
values with the following constraints; invalid tuning is not guaranteed to
produce `InvalidInputError` and may instead result in a no-op or a database or
runtime error.

| Option | Used by | Default and caller constraint |
| --- | --- | --- |
| `batchSize` | pass, worker | Model limit, or 10 if unavailable; use a positive integer. A requested value is capped at the model's finite `maxEmbeddingsPerCall`. |
| `maxBatches` | pass | Unlimited; use a nonnegative integer. `0` performs no claims. |
| `maxDurationMs` | pass | Unlimited; use a nonnegative duration. Checked between batches; `0` performs no claims. |
| `leaseDurationMs` | pass, worker | 300,000 ms; use a positive duration. |
| `maxAttempts` | pass, worker | 3; use a positive integer. |
| `intervalMs` | worker | 1,000 ms; use a nonnegative duration. |
| `pruneRetentionMs` | worker | 604,800,000 ms (7 days); use a nonnegative duration. |

`signal` is checked before each claim. Time and cancellation bounds are
cooperative: an in-flight provider call and write-back finish before the pass
returns. Worker `onError` callback behavior is described in the
[embedding guide](../guides/embeddings.md#run-a-continuous-worker).

#### `noEmbedding`

An `EmbeddingModel` for handles that never generate vectors — an ingest-only
process, a pipeline that supplies precomputed vectors, or an index used only
with keyword and filter search.

```ts
import { noEmbedding, openIndex } from "searchgres";

const ingest = await openIndex(sql, "docs_index", { embedding: noEmbedding });
```

Writes, reads, tree operations, `search` with `fulltext`, `filter`, or a
precomputed `vector`, `queueStats()`, `listEmbeddingFailures()`,
`retryEmbeddingFailures()`, and `pruneEmbeddingQueue()` all work. Records
written without a vector queue as usual and are drained by a handle
opened with a real model. `search({ semantic })`, `processEmbeddings()`, and
`startEmbeddingWorker()` throw [`EmbeddingUnavailableError`](errors.md) before
claiming any queue row or running any query. Compare by identity:
`index.embedding === noEmbedding`.

### Vector index maintenance

| Method | Returns | Notes |
| --- | --- | --- |
| `reindexVectorIndex(options?)` | `void` | Runs `REINDEX INDEX [CONCURRENTLY]` on the vector index. For `prism` (experimental), it first runs `ANALYZE` on the record table so the rebuild sizes `nlist` from the current row count. Options: `concurrently?: boolean`, `lockTimeoutMs?: number`, `statementTimeoutMs?: number`. Rejects a transaction handle. searchgres does not report vector index health; for `prism`, see [Evaluate and maintain a `prism` index](../guides/indexes.md#evaluate-and-maintain-a-prism-index). |

### Transactions and lifecycle

| Method | Returns | Notes |
| --- | --- | --- |
| `with(tx)` | `TransactionIndex` | Record/tree/search/write ops bound to a caller transaction. Prefer `vector` over `semantic` for searches inside it — see the guide. |
| `drop()` | `void` | `DROP SCHEMA ... CASCADE`. |

`TransactionIndex` excludes the embedding and queue methods by design. See
[Manage records and trees](../guides/records-and-trees.md#compose-in-a-transaction).

## Truncators

Runtime policy applied to record content and query text before embedding.

```ts
noTruncation                              // default; no-op
truncateCharacters(maxChars)              // UTF-16 code units
truncateBytes(maxBytes)                   // UTF-8 bytes
truncateTokens({ encode, decode, maxTokens }) // caller-supplied codec
```

```ts
type Truncator = (text: string) => string | Promise<string>;
type TokenCodec = {
  encode(text: string): ArrayLike<number>;
  decode(tokens: number[]): string;
};
```

## Errors

All errors extend `SearchgresError`. Validation failures are
`InvalidConfigError` (how an index is created/opened) or `InvalidInputError`
(input to an open index); both extend `ValidationError` and carry `issues`.
`EmbeddingUnavailableError` means the handle was opened with `noEmbedding`. See
[Errors and recovery](errors.md).
