# Architecture and responsibilities

searchgres.js is a library and a managed PostgreSQL index format. It deliberately
solves retrieval mechanics while leaving application policy in the application.

## Responsibility boundary

| searchgres.js owns | Your application owns |
| --- | --- |
| Index schema and schema-local SQL routines | Source documents and chunking |
| BM25, HNSW/PRISM, GiST, and GIN indexes | Embedding model and provider credentials |
| Hybrid RRF and structured filter execution | PostgreSQL connection lifecycle |
| Query embedding orchestration | Authentication, authorization, and tenancy policy |
| Database-backed embedding queue and worker | Retrieval prompts and answer generation |
| Record validation, versions, and typed errors | Optional extraction, summarization, and reranking |

The boundary is compositional rather than restrictive. A hosted API, source-table
indexer, agent tool, or RAG service can all be built around the same core. The
repository's direct CLI, MCP command, and Compose stack demonstrate some of
those arrangements.

## One schema per index

Each searchgres.js index is a literal caller-named PostgreSQL schema containing:

- a `record` table;
- an `embedding_queue` table;
- native indexes for vectors, BM25, trees, metadata, and time;
- integrity and queue triggers;
- schema-local CRUD, tree, and search routines;
- a schema-format `version` marker and `migration` ledger.

There is no global searchgres.js catalog. Your application tracks its index names.
Several schemas can share one `postgres.js` pool, and separate pools can point at
different databases.

Every runtime query is schema-qualified. searchgres.js never persistently mutates
the pool's `search_path` and never closes a pool it did not create.

## Why logic lives in PostgreSQL

Core reads and writes call schema-local, `security invoker` SQL routines. This
provides consistent behavior for the TypeScript API and direct SQL callers while
keeping integrity triggers effective for every writer.

Database-native primitives do the specialized work:

- `pgvector` (HNSW) and optional `pg_vectorsearch` (PRISM) for cosine retrieval;
- `pg_textsearch` for BM25;
- `ltree` and GiST for hierarchical scope;
- `tstzrange` and GiST for represented time;
- JSONB and GIN for metadata.

The TypeScript layer validates public inputs, embeds query text, invokes the
routines, maps errors, and emits OpenTelemetry instrumentation.

## Embedding is an asynchronous dataflow

When a writer inserts content without an embedding, a database trigger creates
queue work. A drainer later:

1. claims current work with `FOR UPDATE SKIP LOCKED`;
2. commits the claim;
3. calls the caller-supplied embedding model outside a transaction;
4. writes the vector only if the record version is still current.

This design lets source writers operate without AI credentials and allows
several worker processes to drain one index safely. A caller can also provide a
vector directly and skip the queue.

BM25 and structured filters do not wait for embedding generation.

## Building a service around the library

A hosted or internal search API typically owns:

- the database pool and index handle;
- provider configuration and the embedding worker;
- request authentication;
- mandatory access filters;
- rate limits and network policy;
- response projection and optional reranking.

The included `searchgres` binary demonstrates pool, model, and worker ownership
through direct CLI and MCP operations, not an HTTP server. An application can
expose its own REST, GraphQL, RPC, job, or in-process interface and owns the
necessary authentication and perimeter controls.
See [Reference implementations and evaluation tools](../reference-applications.md).

## Access control with composable filters

The core has no identity model. Applications can translate authenticated
identity into an enforced filter:

```ts
const scope = { tree: `tenants.${tenantLabel}` } as const;

return index.search({
  semantic: request.query,
  fulltext: request.query,
  filter: request.filter
    ? { and: [scope, request.filter] }
    : scope,
});
```

Metadata filters can represent ACL or ownership facets when hierarchy is not the
right model. These are valid authorization mechanisms only when the trusted
application constructs the final query and untrusted callers cannot reach an
unscoped handle or database role.

For defense in depth, combine application enforcement with separate indexes,
database roles and grants, or database-level policy appropriate to your threat
model. `tree` and `meta` are data dimensions; searchgres.js does not claim that a
caller-supplied filter is itself authentication.

## Derived content and pipelines

searchgres.js begins at the record boundary. Before that boundary, your pipeline
may:

- parse and chunk files;
- project rows from existing tables;
- extract facts or entities;
- generate summaries;
- attach hierarchy, metadata, and represented time.

After retrieval, it may rerank, deduplicate, expand neighboring chunks, format
context, and call a generation model. Because search results contain the full
record, these stages do not require a second fetch.

## Index shape and explicit migrations

Vector type, dimensions, and index settings become PostgreSQL objects at
creation. Routine and schema format upgrades are applied explicitly with
`migrateIndex` or `searchgres migrate`; `openIndex` never runs DDL. To change
vector dimensions, vector type, or the embedding model, create a new schema,
backfill it, validate it, and switch application traffic.

This makes database state explicit and avoids hidden migration or configuration
drift.

Next: [Create and manage indexes](../guides/indexes.md).
