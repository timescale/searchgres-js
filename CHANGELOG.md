# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Add optional `documentPrefix` and `queryPrefix` to `openIndex()` (and
  `embedding.documentPrefix` / `embedding.queryPrefix` in CLI config) for
  models that need task prefixes, such as Nomic's `search_document: ` and
  `search_query: `. The worker puts `documentPrefix` before record content and
  `search({ semantic })` puts `queryPrefix` before query text. Both default to
  `""`. Stored content, full-text search, and supplied vectors do not change.
  The prefix counts toward the truncation budget. If the prefix alone does not
  fit, `InvalidConfigError` is thrown before any work is claimed, and the
  worker stops with `stopped: true`.
- Add `ensureExtensions(sql, options?)` to install required PostgreSQL
  extensions in `public` under a database-wide lock, and decouple extension
  installation from `createIndex` so index provisioning uses a per-schema lock.
- Add `migrateIndex(sql, schema, options?)` and `searchgres migrate` for
  explicit in-place upgrades from schema format `2` to `3` using a per-index
  `<schema>.migration` ledger and repeatable `CREATE OR REPLACE` routine and
  trigger definitions.
- Add experimental `pg_vectorsearch` (`prism`) vector index support at
  `createIndex()` time via `vectorIndex: { method: "hnsw" | "prism", ... }`.
  pg_vectorsearch is not GA, so until it is, the `prism` option and its
  behavior can change or be removed in a minor release. searchgres does not
  report `prism` health; the indexes guide shows how to evaluate an index with
  pg_vectorsearch's own inspection functions.
- Add `index.reindexVectorIndex(options?)` and CLI
  `searchgres vector-index reindex` to rebuild the vector index
  (`concurrently`, `lockTimeoutMs`, `statementTimeoutMs`). For `prism`, the
  rebuild runs `ANALYZE` first so it sizes its lists from the current row
  count.

### Changed

- Author persisted index DDL, triggers, and schema-local routines in embedded
  `.sql` files under `packages/core/src/db/sql/`, and advance
  `SCHEMA_FORMAT_VERSION` to `"3"`.
- Replace `IndexConfig.hnsw` with the discriminated union
  `IndexConfig.vectorIndex` (`{ method: "hnsw", m?, efConstruction? } | { method: "prism", nlist?, targetPages? }`).
- Support postgres.js 4 as well as 3. `postgres` is now a peer dependency
  (`^3.4.9 || ^4.1.0`) instead of a regular dependency. Previously a
  postgres.js 4 `sql` instance failed at the first write, because core used
  `sql.array()`, which postgres.js 4 removed. Bulk arrays are now plain
  arrays with `::text[]` casts, which both majors encode correctly.
- Say why an index is invalid: `InvalidIndexError` now reports a missing
  schema or a missing vector index.
- The CLI and MCP server now keep the messages of index, schema-format,
  extension, dimension, batch-size, embedding-availability, and timeout
  errors, and add a safe failure class (HTTP status, SQLSTATE, or system
  error code) to provider and database failures. Previously most of these
  printed only `searchgres.js operation failed (CODE)`.
- Document that Docker containers that build a `prism` index need
  `/dev/shm` larger than `maintenance_work_mem`, and set `shm_size: 1g` in the
  evaluation Compose stack.

### Documentation

- CLI guide: document the experimental `prism` workflow (init, import, drain the
  queue until `pending.total` is 0, run `vector-index reindex` once, then
  evaluate), and which extensions `init` installs and which privileges that
  needs.
- Embeddings guide: show how to use a local or other OpenAI-compatible endpoint
  with `createOpenAI({ baseURL, apiKey })`, and suggest an explicit `batchSize`
  for local servers.
- Getting started: explain how to silence or route `pg_textsearch` NOTICE
  messages with the postgres.js `onnotice` option.
- Explain exactly what `listTree` matches, and point to `treeView` to list the
  children of a node.
- Explain that `metaPredicate` must be a boolean JSONPath predicate. A bare
  path matches nothing.
- How search works: describe `prism`, and that a filtered `prism` semantic
  search can return fewer rows than `limit`.

### Fixed

- A wrong-dimension embedding model no longer loops forever. In
  `processEmbeddings()` and the embedding worker, the claimed batch now fails
  permanently at once (no retries), so the rows appear in `queueStats()` and
  `listEmbeddingFailures()`. The pass throws `DimensionMismatchError` and claims
  no more rows. The worker reports the error to `onError` with the new
  `WorkerErrorContext.stopped: true` and stops. Before, the rows were released
  and the worker retried them every few seconds without recording a failure.
  The CLI `embeddings worker` command exits `1` when all its workers stop. A
  new schema-local routine, `<schema>.fail_embedding_permanently()`, records
  these failures.
- `ProcessEmbeddingsResult` has a new `sampleError` field: the first error that
  made rows fail in the pass, or `null`. Before, a pass that failed (for example
  with a mistyped model id) returned only counts. The CLI prints only its safe
  error class (for example `HTTP 404`).
- `reindexVectorIndex({ statementTimeoutMs })` now also applies the value to
  `transaction_timeout`, and sets the timeouts before the rebuild's transaction
  starts. Before, a session `transaction_timeout` shorter than the rebuild (the
  CLI default is 35s) ended the session in the middle of a rebuild, whatever
  `statementTimeoutMs` or `--statement-timeout` said.
- Clearer validation and error messages: a UUID that is not a UUIDv7 now says
  `expected a UUIDv7`, and a timestamp without an offset says it needs a UTC
  offset or `Z`. An invalid schema name now carries `issues`. `createIndex()`
  on an existing schema says `Schema "..." already exists` instead of calling
  it an index. A `NotFoundError` for a `(tree, name)` address now reads
  `Record with tree "docs", name "intro" was not found` instead of
  `"docs/intro"`, which looked like a slash path.
- CLI: argument errors (unknown option, conflicting options) now use the same
  JSON error envelope as other errors, with code `INVALID_INPUT` and exit `2`.
  When stderr is a terminal, all errors print as readable text instead of
  JSON; other destinations get the same single JSON line as before.
- CLI: a filter expression that is missing its closing `)` now reports
  "expected `)`" at the end of input instead of an arity error.
- CLI: search validation errors name the CLI flags (for example
  `--candidate-limit`) instead of library option names.
- CLI: the config dimension-limit error names the index method, vector type,
  limit, and value.
- CLI and MCP: selected fields are printed in the requested order.
- CLI: `delete` prints the deleted record's id, or its tree and name, instead
  of `{}`. `update --meta` help says that it replaces all metadata.
- Filter validation errors now name the problem and its location: an unknown
  filter key (with a hint to use `meta` for metadata fields), a node with zero
  or several keys (with a hint to use `and`), or an invalid value at its full
  path (for example `filter.and.1.tree`). Before, most mistakes gave only
  `filter: Invalid input`. The same messages apply to MCP filter input.
- The exported `Filter` type now describes the filter shape. Before, it
  resolved to `unknown`, so TypeScript did not check filters passed to
  `search()`. Code that passed an invalid filter shape can now fail to compile.
- `openIndex()` now rejects a model id string for `embedding` with
  `InvalidConfigError`. The AI SDK resolves a string through its global
  default provider, which is the Vercel AI Gateway unless the application sets
  another one, so a string could send record and query text to a third party
  without any explicit choice. Pass a provider model object instead (for
  example `openai.embedding("text-embedding-3-small")`). The `embedding` option
  type is now `IndexEmbeddingModel` (`EmbeddingModel` without `string`).
- **Security:** the compiled `searchgres` binary no longer loads `.env` or
  `bunfig.toml` from the current working directory. Bun standalone executables
  load both by default. A `bunfig.toml` `preload` entry could run arbitrary
  code when the binary started in an untrusted directory, and a `.env` file
  overrode `--env-file` and `--no-env-file`.

## [0.3.2] - 2026-09-18

### Changed

- Rename the project to searchgres.js and its GitHub repository to
  `timescale/searchgres-js`. The npm package and CLI remain `searchgres`;
  configuration, public APIs, MCP tool IDs, telemetry, and database formats
  are unchanged.

## [0.3.1] - 2026-09-17

### Fixed

- Restore cross-platform reference-binary publishing by invoking the pinned Bun
  executable directly, and verify that unpinned installer runs resolve the
  latest GitHub release tag before downloading assets.

## [0.3.0] - 2026-09-17

### Changed

- Replace the reference server/client/protocol stack with one compiled
  `searchgres` binary that connects directly to one configured PostgreSQL index.
  Provisioning moves to `searchgres config/init/destroy`; MCP is now
  `searchgres mcp`, with one background embedding worker by default.
- Add `embeddings process/worker/status/failures/retry/prune` commands using core's
  existing public APIs. Retain exact tokenizer presets and bundled assets with
  lazy worker-thread initialization. CLI exit codes are 0 (success), 2 (the
  request cannot succeed as written: input errors, `NOT_FOUND`, `CONFLICT`,
  `STALE_VERSION`), and 1 (operational failure).
- CLI and MCP present `temporal` in its input shape (ISO `[instant]` or
  `[start, end]`) instead of PostgreSQL range text, retain core's validation
  and record-state messages while keeping provider and driver errors code-only,
  and present queue state as explicit nested pending/terminal-failure groups.
- Compose now exposes PostgreSQL and Ollama on loopback for host CLI query
  embedding, with one-shot model/index initialization and a continuous worker.
- Remove the old reference packages, separate server/MCP binaries, HTTP/RPC
  service, and server URL/config compatibility. Core's package and API are
  unchanged.

## [0.2.0] - 2026-09-10

### Added

- OpenTelemetry parent spans for every public core operation that performs I/O,
  with stable `searchgres.<domain>.<operation>` names, index schema, safe
  operation/result attributes, single-record UUIDv7 correlation, consistent
  error status, and child SQL spans. Continuous worker ticks are detached from
  startup context and represented as independent traces; worker start and stop
  have short lifecycle spans.
- `noEmbedding`: an `EmbeddingModel` for handles that never generate vectors
  (ingest-only processes, precomputed-vector pipelines, keyword/filter-only
  search). Writes still queue embedding work for a handle opened with a real
  model; `search({ semantic })`, `processEmbeddings()`, and
  `startEmbeddingWorker()` throw the new `EmbeddingUnavailableError`
  (`EMBEDDING_UNAVAILABLE`) before claiming any queue row.
- `startEmbeddingWorker({ onError })`: a callback receiving each failed tick
  with `{ phase, consecutiveErrors, backoffMs }`. Previously the worker
  swallowed every failure (a misconfigured model, a revoked key, an unreachable
  database) and retried with silent backoff; without an OTel SDK there was no
  way to observe it. The server wires this to `console.error` by default and
  accepts `startServer(config, { onWorkerError })` to redirect it.
- The `searchgres.embedding.process` span records a thrown pass (`ERROR` status
  + exception event) and emits an `embedding.batch_failed` event for provider
  failures the pass absorbs into the queue.

### Changed

- SQL spans now use `SpanKind.CLIENT`; caller-level operation spans use
  `SpanKind.INTERNAL`. SQL remains independently identifiable through the
  `searchgres/sql` instrumentation scope and `searchgres.sql=true` attribute.
- Runnable create-and-search examples now use ownership-fenced temporary schemas
  and clean them up in `finally`, so repeated, concurrent, and failed runs do not
  conflict or remove pre-existing schemas.
- The MCP reference documentation is consolidated into one compact tool guide;
  MCP discovery remains the source of truth for strict input schemas.
- Server config environment references must use portable dotenv-compatible
  names (`[A-Za-z_][A-Za-z0-9_]*`) instead of arbitrary nonempty strings.
- `upsert`, `upsertMany`, and `patch` reject an empty `content` and an
  empty-string `name` with `InvalidInputError`. Empty content could never be
  embedded and only produced a terminal `failed` queue row; use `null` for an
  unnamed record.
- Filter depth and node limits are enforced on the raw input before schema
  parsing, so an oversized filter from an untrusted caller raises
  `InvalidInputError` instead of a stack-overflow `RangeError`.
- `createIndex` accepts an optional fourth argument, `CreateIndexOptions`, with
  `lockTimeoutMs` (default 30 s) and `transactionTimeoutMs` (default 20 min)
  for the provisioning lock wait and transaction budget. Both were previously
  fixed. Invalid options throw `InvalidConfigError`.
- `openIndex` validates its `options` before any database access and throws
  `InvalidConfigError` for a missing or malformed `embedding`, a non-function
  `truncate`, or an unknown key. Previously `openIndex(sql, schema, {})`
  succeeded and the first semantic search or drain failed inside the AI SDK.
- **Schema format 2:** `updatedAt` now advances only when a versioned record
  field (`content`, `tree`, `name`, `meta`, or `temporal`) changes, matching
  `version` and `versionHash`. Embedding write-back still advances the internal
  staleness fence and can change `hasEmbedding`, but no longer produces a
  phantom timestamp update. Existing format-1 indexes must be recreated and
  reindexed; `openIndex` rejects them with `SchemaVersionError`.
- **Error taxonomy split.** `InvalidConfigError` (`INVALID_CONFIG`) now covers
  only how an index is created or opened (`createIndex` config, schema names,
  truncator limits). Invalid input to an operation on an open index — a
  malformed record, patch, search option, filter, or tree selector — raises the
  new `InvalidInputError` (`INVALID_INPUT`). Both extend the new abstract
  `ValidationError`, which carries `issues`. Code that caught
  `InvalidConfigError` around `search`/`upsert`/`patch`/tree calls should catch
  `InvalidInputError` or `ValidationError`.
- `truncateCharacters`, `truncateBytes`, and `truncateTokens` throw
  `InvalidConfigError` instead of a bare `RangeError` for a non-positive limit.
- Docs: the supported Bun version is 1.4 or newer everywhere (getting-started
  said 1.2); `treeView` is documented in the API reference; the observability
  guide no longer claims metrics (the core emits traces only).

### Fixed

- Malformed `lquery`, `ltxtquery`, `regexp`, and `metaPredicate` (JSONPath)
  patterns in `search`, `listTree`, and `countTree` now raise
  `InvalidInputError` instead of leaking the driver's `PostgresError`
  (SQLSTATE `42601`/`2201B`). The driver error is kept as `cause` and the
  SQLSTATE is the single issue's `code`.
- `pruneEmbeddingQueue` rejects a negative or non-finite `retentionMs` with
  `InvalidInputError` instead of failing inside PostgreSQL (or silently
  pruning everything).

- `dropIndex` (and `Index.drop()`) no longer treats any schema containing a
  table named `version` as a searchgres index. `createIndex` now stamps the
  schema with a `COMMENT`, and `openIndex`/`dropIndex` require that comment,
  the `version`/`record`/`embedding_queue` tables, and a single format-version
  row before acting. Look-alike caller schemas raise `InvalidIndexError` and
  are left untouched. Indexes provisioned by earlier 0.1.x releases lack the
  comment and must be rebuilt (or stamped manually with
  `COMMENT ON SCHEMA <schema> IS 'searchgres index'`).

## [0.1.2] - 2026-09-04

### Fixed

- Database integration tests now serialize direct extension provisioning with
  `createIndex`, preventing concurrent `CREATE EXTENSION` calls from racing on
  fresh CI databases.

## [0.1.1] - 2026-09-04

### Fixed

- `upsert` and `upsertMany` now work on the same `postgres.js` pool connection
  that `createIndex` used to install `ltree` and `pgvector`. Batch arrays are
  bound through the built-in `text[]` serializer and cast to their qualified
  destination types, avoiding stale per-connection custom-array type maps while
  preserving parameterization, nulls, and array escaping.

## [0.1.0] - 2026-09-03

### Added

- Project scaffolding: license, notice, readme, npm workspace, TypeScript 7
  build, runtime-portability lint rules, and cross-runtime package smoke tests.
- Initial public core primitives: typed errors and Zod-backed schema, ltree, and
  index-creation validation with inferred TypeScript types, structured
  validation issues, and pgvector, pg_textsearch, and HNSW defaults and bounds.
- Database plumbing: PostgreSQL 18 preflight, serialized extension installation
  and schema discovery, transaction-local migration timeouts, SQL spans, typed
  timeout/extension failures, Docker-backed integration tests, and CI coverage.
- Immutable schema provisioning: one atomic `createIndex` flow, singleton format
  marker, record and queue schemas, configured search indexes, and
  integrity/enqueue triggers that protect asynchronous embedding for direct SQL
  writers. Existing schemas are rebuilt rather than migrated in place.
- Core builds clean emitted artifacts first, preventing deleted source modules
  from remaining in published tarballs.
- Catalog-derived `openIndex` validation with immutable schema-format checks,
  required embedding models, and vector/HNSW shape inspection.
- Bulk `Index.upsertMany` and single-record `Index.upsert` writes with validated
  record inputs, conflict handling, precomputed embeddings, and queue-safe
  replacement behavior.
- UUIDv7 enforcement for supplied and direct record IDs, plus concurrency-safe
  skipped-conflict result resolution.
- Writes execute through a schema-local `batch_upsert` PL/pgSQL routine created
  with the index and callable directly from SQL; its body is part of the
  immutable schema format. The library validates inputs, calls the routine, and
  maps its conflict/validation SQLSTATEs to typed errors.
- Extensions are now public-only: `vector`, `pg_textsearch`, and `ltree` must
  live in `public`. `createIndex` installs missing ones there and rejects any
  installed in another schema (`ExtensionError` `reason: "wrong_schema"`).
  Bulk-write arrays are passed as bare parameters coerced by the routine
  signature, removing the previous manual PostgreSQL array-literal encoding.
- `Index.search` for filter-only, keyword (BM25), semantic (cosine), and hybrid
  (RRF) retrieval. The mode is inferred from the supplied arms (`semantic` or
  `vector`, and/or `fulltext`); there is no `mode` field. Filters are a composable
  boolean AST (`and`/`or`/`not` over `tree`, `lquery`, `ltxtquery`, `meta`,
  `metaPredicate`, temporal, and `regexp` leaves) applied to every mode. Results
  are always the full record plus a score. Filter-only listing supports `order`
  and `after`/`before` keyset paging; ranked search is fused top-k.
- Search executes through schema-local `search_records`, `hybrid_search_records`,
  and `compile_filter` PL/pgSQL routines created with the index and callable
  directly from SQL; their bodies are part of the immutable schema format. Filter
  values are always bound data, never interpolated into SQL. The BM25
  positive-match invariant and HNSW iterative strict-order scan are preserved, and
  a `regexp` may not be the sole filter criterion.
- Caller-supplied `Truncator` (`truncate` option on `openIndex`, default
  `noTruncation`) with `truncateCharacters`, `truncateBytes`, and `truncateTokens`
  built-ins, applied to semantic query text before embedding.
- Asynchronous embedding engine: `Index.processEmbeddings()` drains the queue in
  a bounded pass; `Index.startEmbeddingWorker()` runs a continuous, concurrency-
  safe drainer whose `stop()` finishes the in-flight batch and never closes the
  caller's pool; `Index.queueStats()` and `Index.pruneEmbeddingQueue()` inspect
  and maintain the queue. The queue is the retry authority: claims use `for
  update skip locked` with a lease, write-back is version-guarded so a stale
  vector can never overwrite a newer one, ordinary failures retry until
  `maxAttempts`, and rate limits / wrong dimensions release the work and throw.
  Durations are milliseconds (`leaseDurationMs`, `maxAttempts`,
  `pruneRetentionMs`); batch size is clamped to the model's `maxEmbeddingsPerCall`.
- The record integrity trigger now treats `content_version` as the embedding-
  input fence: it advances when the content or the stored vector changes, so a
  precomputed vector supplied after enqueue invalidates the stale queue row. The
  enqueue trigger fires on content-or-embedding changes that leave the row
  needing a vector, and covers direct SQL writers.
- Record operations: `Index.get()` / `getByName()` read a full record (throwing
  `NotFoundError`); `Index.patch()` optimistically updates by `versionHash`
  (distinguishing `NotFoundError` from `StaleVersionError` in one round trip,
  returning the updated record, and accepting an optional precomputed embedding);
  `Index.delete()` / `deleteByName()` remove a record.
- Tree operations: `Index.moveTree()` / `copyTree()` / `deleteTree()` operate on
  inclusive subtrees (with `dryRun`), returning affected counts; `countTree()`
  takes one explicit filter kind (`tree`/`lquery`/`ltxtquery`) with an optional
  cap; `listTree()` returns per-node descendant counts.
- `Index.with(tx)` returns a `TransactionIndex` binding record/tree/search/write
  operations to a caller-owned transaction; embedding and queue methods are
  excluded by design.
- `dropIndex()` / `Index.drop()` removes a searchgres index (`drop schema …
  cascade`) after verifying the schema is one.
- These record and tree behaviors run through new schema-local routines
  (`get_record`, `get_record_by_name`, `patch_record`, `delete_record`,
  `delete_record_by_name`, `move_tree`, `copy_tree`, `delete_tree`, `count_tree`,
  `list_tree`) created with the index and callable directly from SQL.

### Changed

- The SQL `stable` read routines (`get_record`, `get_record_by_name`,
  `list_tree`, and the three `count_tree` overloads) no longer carry a
  function-level `set search_path`, which lets PostgreSQL inline the
  set-returning ones (`get_record`, `get_record_by_name`, `list_tree`) into the
  calling query instead of planning an opaque function scan. Their bodies are
  fully qualified — table by schema, ltree objects by `public`, and built-in
  operators/functions by `pg_catalog` — so they remain correct under any caller
  `search_path`. Mutating and PL/pgSQL routines keep their fixed path.
