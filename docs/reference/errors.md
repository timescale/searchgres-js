# Errors and recovery

Every error searchgres.js raises for a caller-facing condition — bad input, bad
configuration, a missing record, a conflict, a timeout, a provider failure —
extends `SearchgresError` and carries a stable `code`. Catch the base class to
detect any searchgres.js error, or a specific subclass to handle one case:

```ts
import { SearchgresError, StaleVersionError } from "searchgres";

try {
  await index.patch(id, versionHash, { content });
} catch (error) {
  if (error instanceof StaleVersionError) {
    // re-read and retry
  } else if (error instanceof SearchgresError) {
    // any other searchgres.js error
  } else {
    throw error;
  }
}
```

Each error also exposes a machine-readable `code` (e.g. `"STALE_VERSION"`) and,
where useful, extra fields described below.

## Input and configuration

Both validation errors extend the abstract `ValidationError`, which carries
`issues`: a list of structured `{ code, message, path }` problems. Match on
`ValidationError` when you only need the issues (for example to build a 400
response) and on the concrete class when the distinction matters.

### `InvalidConfigError` (`INVALID_CONFIG`)

How an index is created or opened is invalid: a bad `createIndex` config or
option, missing or malformed `openIndex` options (no `embedding`, a non-function
`truncate`, an unknown key), a malformed schema name, or a truncator
constructed with a non-positive limit.

**Recover:** fix the configuration. These are programming errors, not runtime
conditions.

### `InvalidInputError` (`INVALID_INPUT`)

Input to an operation on an open index is invalid: a malformed record (for
example empty `content` or an empty-string `name`), an invalid patch, a bad search option, a malformed filter, a bad tree selector, a
non-finite `retentionMs`, or a **pattern PostgreSQL rejected** — an `lquery`,
`ltxtquery`, `regexp`, or JSONPath (`metaPredicate`) with a syntax error.

Most input is validated in TypeScript before any SQL runs, and `issues` then
mirrors the validator's output. Pattern syntax is validated by PostgreSQL
itself; in that case `cause` is the driver's `PostgresError`, the message
carries PostgreSQL's explanation, and the single issue's `code` is the SQLSTATE
(`42601` syntax error, `2201B` invalid regular expression, `22023` invalid
parameter value, `22P02` invalid text representation).

**Recover:** fix the input. When a pattern comes from an end user, surface the
message; it names the problem in the pattern.

### `TreePathError` (`TREE_PATH`)

A concrete tree path is not a valid dotted `ltree` (each label must be
`[A-Za-z0-9_-]+`). Carries `path`.

**Recover:** correct the path. `lquery`/`ltxtquery` **patterns** are validated
by PostgreSQL instead; a malformed pattern raises `InvalidInputError`.

### `DimensionMismatchError` (`DIMENSION_MISMATCH`)

A vector's length doesn't match the index. Carries `expected`, `actual`, and (for
batch writes) `position`. Thrown for a supplied embedding of the wrong length, or
when your embedding model returns vectors of a different size than the index was
created with.

In `processEmbeddings()` and the embedding worker, a wrong model output fails
the claimed batch permanently (no retries) and stops the pass or the worker.

**Recover:** ensure `createIndex({ dimensions })` matches your model's output;
re-embed if you changed models. Then retry the failed queue rows.

## Conflicts and versions

### `ConflictError` (`CONFLICT`)

A uniqueness conflict: creating an index schema that exists, an `onConflict:
"error"` write hitting an existing key, or a move/copy/patch landing on an
occupied `(tree, name)` slot.

**Recover:** for writes, choose `ignore` or `replace`; for renames/moves, pick a
free name or remove the occupant first.

### `StaleVersionError` (`STALE_VERSION`)

A `patch` whose `priorVersionHash` no longer matches — the record changed since
you read it. Carries `id`.

**Recover:** re-read the record and retry with the fresh `versionHash`.

### `NotFoundError` (`NOT_FOUND`)

A `get`, `getByName`, `patch`, `delete`, or `deleteByName` addressed a record that
doesn't exist. Carries `target`.

**Recover:** confirm the id or `(tree, name)`. Subtree operations do **not** throw
this — an empty subtree returns a count of 0.

### `BatchTooLargeError` (`BATCH_TOO_LARGE`)

`upsertMany` was given more than 1,000 records. Carries `size` and `maximum`.

**Recover:** split the input into chunks of 1,000 or fewer.

## Embeddings

### `RateLimitError` (`RATE_LIMITED`)

The embedding provider returned HTTP 429. Carries `retryAfterMs` when the
provider supplied it. During a drain, the claimed rows are released and their
attempts refunded before this is thrown, so no work is lost.

**Recover:** back off (honoring `retryAfterMs`) and drain again. A continuous
worker handles this for you.

### `EmbeddingProviderError` (`EMBEDDING_PROVIDER`)

The embedding provider failed for a non-rate-limit reason. The original error is
on `cause`.

**Recover:** inspect `cause`; fix credentials/connectivity and retry.

### `EmbeddingUnavailableError` (`EMBEDDING_UNAVAILABLE`)

The handle was opened with `noEmbedding`, and the operation — `search` with
`semantic` text, `processEmbeddings()`, or `startEmbeddingWorker()` — needs a
model to generate a vector. Carries `operation`. Thrown before any queue row is
claimed or any query runs, so queued work is untouched.

**Recover:** open the index with a real `EmbeddingModel` for that operation, or
search with `fulltext`, `filter`, or a precomputed `vector` instead.

## Provisioning and environment

### `ExtensionError` (`EXTENSION`)

A required extension is missing, too old, unavailable, installed outside
`public`, or missing required cross-extension operator family wiring. Carries
`extension`, `minimumVersion`, `foundVersion`, and `reason` (`"incomplete_setup" |
"missing" | "too_old" | "unavailable" | "permission_denied" | "wrong_schema"`).

**Recover:** install/upgrade the extension in `public`, or grant the connecting
role `CREATE EXTENSION`. See [Install searchgres.js](../installation.md).

### `UnsupportedServerError` (`UNSUPPORTED_SERVER`)

The PostgreSQL server is older than searchgres.js supports. Carries
`serverVersionNum` and `minimumVersionNum`.

**Recover:** use PostgreSQL 18 or newer.

### `InvalidIndexError` (`INVALID_INDEX`)

`openIndex`/`dropIndex` targeted a schema that isn't a searchgres.js index (no valid
version marker or the expected shape is missing). Carries `schema`.

**Recover:** check the schema name, or create the index first.

### `SchemaVersionError` (`SCHEMA_VERSION`)

The index was created by an incompatible searchgres.js schema format. Carries
`schema`, `schemaVersion`, and `supportedVersion`.

**Recover:** for a supported prior format (`2`), run `migrateIndex(sql, schema)`
or `searchgres migrate` during a maintenance window. If the database format is
newer than the library, upgrade `searchgres`. For format `1`, see
[Rebuild and cut over](../guides/indexes.md#rebuild-and-cut-over).

## Database timeouts

Raised when a statement, lock wait, or transaction exceeds its timeout:

- `StatementTimeoutError` (`STATEMENT_TIMEOUT`)
- `LockTimeoutError` (`LOCK_TIMEOUT`)
- `TransactionTimeoutError` (`TRANSACTION_TIMEOUT`)

**Recover:** retry, and investigate contention or long-running work if they
persist. `createIndex` waits up to 30 s for its provisioning lock and allows
20 min for the transaction; both are adjustable through its `options`
argument.
