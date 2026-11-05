# Create and manage indexes

An index is a single PostgreSQL schema holding your records, search indexes,
queue, triggers, and SQL routines. You choose its name and your application
tracks it—searchgres.js keeps no registry and offers no discovery. See
[Architecture and responsibilities](../concepts/architecture.md) for the full
boundary.

## Choose your index shape

A few decisions are fixed at creation time because they become database columns
and indexes. Choose them to match your embedding model and data.

### Dimensions

`dimensions` must equal the length of the vectors your embedding model produces.
For example, OpenAI's `text-embedding-3-small` returns 1536. If they don't match,
embedding writes fail with a `DimensionMismatchError`.

### Vector type

`vectorType` controls how vectors are stored:

| Type | Storage | When to use |
| --- | --- | --- |
| `halfvec` (default) | 16-bit floats | Half the storage; often a small recall impact for normalized embeddings. Evaluate it with your model and corpus. |
| `vector` | 32-bit floats | Use when evaluation shows you need full fp32 precision. |

HNSW caps the dimensions per type: up to **4000** for `halfvec`, **2000** for
`vector`.

Both use cosine distance.

### Keyword and vector index tuning

Sensible defaults are applied; override them only if you have a reason.

| Field | Default | Meaning |
| --- | --- | --- |
| `bm25.textConfig` | `"english"` | PostgreSQL text search configuration for BM25. |
| `bm25.k1` | `1.2` | BM25 term-frequency saturation. |
| `bm25.b` | `0.75` | BM25 length normalization. |
| `hnsw.m` | `16` | HNSW graph connectivity. |
| `hnsw.efConstruction` | `64` | HNSW build-time search width. |

## Create an index

Only `dimensions` is required:

```ts
import { createIndex } from "searchgres";

await createIndex(sql, "docs_index", { dimensions: 1536 });
```

A fully specified example:

```ts
await createIndex(sql, "docs_index", {
  dimensions: 1536,
  vectorType: "halfvec",
  bm25: { textConfig: "english", k1: 1.2, b: 0.75 },
  hnsw: { m: 16, efConstruction: 64 },
});
```

The schema name must be a lowercase PostgreSQL identifier
(`[a-z_][a-z0-9_]*`, at most 63 characters). Creating a schema that already
exists throws a [`ConflictError`](../reference/errors.md).

`createIndex()` is atomic: it either creates the whole index or rolls back
completely. Concurrent calls (in any schema, on the same database) serialize on
one advisory lock because they may install extensions; a call waits up to 30 s
for it by default and the whole transaction is bounded at 20 min. Both budgets
are adjustable through the optional fourth argument:

```ts
await createIndex(sql, "docs_index", { dimensions: 1536 }, {
  lockTimeoutMs: 120_000,       // wait longer behind a slow sibling
  transactionTimeoutMs: 0,      // no transaction budget
});
```

## Open an index

Open an existing index to get a handle for reads, writes, search, and embedding:

```ts
import { openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});

index.schema; // "docs_index"
index.vectorType; // "halfvec"
index.dimensions; // 1536
```

The `embedding` option is always required. Pass a real model when this handle
will generate vectors, or the supported [`noEmbedding`](embeddings.md#credential-separation)
sentinel for ingest-only, precomputed-vector, keyword, or filter-only handles.
searchgres.js reads the vector shape from the database, not from what you pass, and
never compares or stores your model's identity.

Opening a schema that isn't a searchgres.js index throws
[`InvalidIndexError`](../reference/errors.md); one created by an incompatible
version throws [`SchemaVersionError`](../reference/errors.md).

## Truncating long input

An embedding provider has a token limit. searchgres.js never truncates silently;
opt in with a truncator applied to record content and query text:

```ts
import { openIndex, truncateCharacters } from "searchgres";

const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
  truncate: truncateCharacters(24_000),
});
```

Built-ins: `truncateCharacters`, `truncateBytes`, and `truncateTokens` (with a
tokenizer you supply). See the [API reference](../reference/api.md#truncators).

## Multiple indexes

Put as many indexes as you like in one database, or spread them across databases
with separate pools:

```ts
const docs = await openIndex(sql, "docs_index", { embedding: model });
const faqs = await openIndex(sql, "faq_index", { embedding: model });

const other = postgres(process.env.OTHER_DATABASE_URL);
const archive = await openIndex(other, "archive_index", { embedding: model });
```

Every query is fully schema-qualified, so indexes sharing a pool never interfere.

## Upgrade an index in place

When a new searchgres.js release updates the schema format (from format `2` to
`3` or later), upgrade an existing index during a maintenance window with
[`migrateIndex`](../reference/api.md#migrateindexsql-schema-options--promisemigrateindexresult):

```ts
import { migrateIndex, openIndex } from "searchgres";

await migrateIndex(sql, "docs_index");
const index = await openIndex(sql, "docs_index", { embedding: model });
```

Pause readers, writers, workers, and administrative DDL (`createIndex`,
`dropIndex`, `init`, `destroy`) against the index while migrating, then reopen
handles afterward.

The calling database role must own the index schema. Migration is one-way and
preserves existing records, embeddings, queue rows, and BM25/HNSW settings,
returning `{ schema, fromVersion, toVersion, applied }`. Older `0.3.x` clients
cannot open a format-`3` index; upgrade the client package. If the database
connection drops during `COMMIT`, reconnect and check `<schema>.version` or
rerun `migrateIndex`, which is idempotent at the target version.

## Rebuild and cut over

An index's vector shape is immutable. To change `dimensions`, switch vector type,
move to a new embedding model, or replace a legacy format-`1` index, build a
fresh index and cut over:

1. **Create** a new index schema (e.g. `docs_index_v2`) with the new shape.
2. **Backfill** by reading from your source of truth and `upsertMany`-ing into
   the new index. Re-embedding is required when the model changed.
3. **Drain** embeddings: `await newIndex.processEmbeddings()`.
4. **Validate** search quality against the new index.
5. **Switch** your application to the new schema name.
6. **Drop** the old index once you're confident:

   ```ts
   await oldIndex.drop(); // or dropIndex(sql, "docs_index")
   ```

`drop()` runs `DROP SCHEMA ... CASCADE` after confirming the schema really is a
searchgres.js index.

Next: [Ingest records](ingest.md).
