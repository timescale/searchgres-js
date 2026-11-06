# searchgres.js

[![npm version](https://img.shields.io/npm/v/searchgres.svg)](https://www.npmjs.com/package/searchgres)
[![CI](https://github.com/timescale/searchgres-js/actions/workflows/ci.yml/badge.svg)](https://github.com/timescale/searchgres-js/actions/workflows/ci.yml)
[![Apache 2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](https://github.com/timescale/searchgres-js/blob/main/LICENSE)

**Excellent hybrid search in the Postgres you own.**

searchgres.js is an open-source TypeScript library that combines BM25 keyword
search, vector search, Reciprocal Rank Fusion, and structured filters in
PostgreSQL. Bring a [`postgres.js`](https://github.com/porsager/postgres)
connection and an [AI SDK](https://ai-sdk.dev) embedding model; searchgres.js
manages the search schema, indexes, and embedding workflow.

- Find both **exact terms and related meaning**.
- Scope retrieval by **hierarchy, JSON metadata, time, and regex**.
- Keep your search index in **PostgreSQL you control**, not a separate vector
  service.
- Use the library directly without adopting a RAG framework, server, or content
  model.

## Install and search

searchgres.js is published on npm as `searchgres`.

```bash
npm install searchgres postgres @ai-sdk/openai
```

```ts
import { openai } from "@ai-sdk/openai";
import postgres from "postgres";
import { createIndex, ensureExtensions, openIndex } from "searchgres";

const sql = postgres(process.env.DATABASE_URL);

try {
  // Run once. Install extensions in public and create the index schema.
  await ensureExtensions(sql);
  await createIndex(sql, "docs_index", { dimensions: 1536 });

  const index = await openIndex(sql, "docs_index", {
    embedding: openai.embedding("text-embedding-3-small"),
  });

  await index.upsertMany([
    {
      content: "Auth tokens rotate every 24 hours.",
      tree: "docs.auth",
      meta: { audience: "operators" },
    },
    {
      content: "Rate limits are 100 requests per minute for each API key.",
      tree: "docs.api",
      meta: { audience: "developers" },
    },
  ]);

  // New records work with BM25 and filters. Drain before semantic search.
  await index.processEmbeddings();

  const hits = await index.search({
    semantic: "how are request limits enforced?",
    fulltext: "rate limit",
    filter: {
      and: [
        { tree: "docs.api" },
        { meta: { audience: "developers" } },
      ],
    },
    limit: 5,
  });

  for (const hit of hits) console.log(hit.score, hit.tree, hit.content);
} finally {
  await sql.end(); // searchgres.js never closes the caller-owned connection
}
```

See **[Get started](https://github.com/timescale/searchgres-js/blob/main/docs/getting-started.md)**
for the complete walkthrough.

<a id="why-searchgres"></a>

## Why searchgres.js

### Search quality beyond vector similarity

Pure semantic search struggles with identifiers, exact phrases, dates, and
scope. searchgres.js gives each query the retrieval strategy it needs:

- **BM25** for exact and lexical relevance.
- **Vector search** for related meaning when wording differs.
- **RRF hybrid search** to combine both rankings without mixing incompatible raw
  score scales.
- **Composable filters** over tree paths, JSONB metadata and JSONPath, temporal
  ranges, and regex.
- **Filter-only listing** when ranking is unnecessary.

### Postgres-native, not another retrieval stack

A searchgres.js index is an ordinary PostgreSQL schema containing records, SQL
routines, and native indexes: HNSW through `pgvector` (or PRISM through
`pg_vectorsearch`, experimental), BM25 through `pg_textsearch`, GiST for hierarchy and time,
and GIN for metadata.

That means one database to operate, one transaction system, normal backups and
replication, and direct SQL access when you need it. Your search index lives in
PostgreSQL you control rather than in a separate proprietary service.

### Search mechanics without application policy

searchgres.js owns the mechanics of retrieval, not your application architecture:

- You own the connection pool, embedding provider, credentials, and source data.
- You decide how to chunk, summarize, extract, or otherwise derive records.
- You can organize raw and derived records in one index or several indexes.
- You can call the TypeScript API or the schema-local SQL routines.
- The core contains no user, account, or authorization model.

No fact-extraction pipeline, opaque summarization, or RAG framework is imposed.

## How search works

`index.search()` infers the retrieval mode from the arguments you pass:

| Input | Behavior |
| --- | --- |
| `semantic` or a precomputed `vector` | HNSW cosine search |
| `fulltext` | BM25 keyword search |
| `semantic` and `fulltext` | RRF hybrid search |
| filters only | UUIDv7-ordered listing with keyset pagination |
| either ranked arg plus `filter` | Filtered and ranked retrieval |
| both ranked args plus `filter` | Filtered and RRF hybrid search retrieval |

Every hit is the full record plus its score. Newly written records are available
to BM25 and filters immediately, including the BM25 arm of hybrid search. Their
vectors are needed only for semantic participation. Drain the built-in embedding
queue with a bounded `processEmbeddings()` pass or a concurrency-safe background
`EmbeddingWorker`.

Read **[How search works](https://github.com/timescale/searchgres-js/blob/main/docs/concepts/how-search-works.md)**
or jump to **[Search and filter](https://github.com/timescale/searchgres-js/blob/main/docs/guides/search.md)**.

## Compose it into your application

The core is deliberately a library. You can use it to build:

- application search or a hosted search API;
- an indexing pipeline fed from existing tables through code, SQL, or triggers;
- RAG retrieval with your own chunking and generation stages;
- raw, summarized, or fact-extracted representations organized by tree;
- application-enforced access scopes by injecting mandatory tree or metadata
  filters;
- a post-retrieval reranking stage.

Authentication and authorization remain an application or database concern.
Filters become an access-control boundary only when callers cannot bypass the
layer that injects them or issue unrestricted database queries.

See **[Architecture and responsibilities](https://github.com/timescale/searchgres-js/blob/main/docs/concepts/architecture.md)**
and **[Choosing searchgres.js](https://github.com/timescale/searchgres-js/blob/main/docs/comparison.md)**.

## Evidence behind the design

The architecture behind searchgres.js was evaluated on conversational-memory and
multi-hop retrieval benchmarks using a simplified prototype based on the same
core approach: one Postgres record table, BM25, HNSW vectors, RRF, and structured
filters—without knowledge graphs or fact-extraction pipelines.

- **LoCoMo:** `F1=0.666` after search-tool refinement, compared with `F1=0.493`
  for the fixed retrieval baseline in the same experiments.
- **MuSiQue:** `86.5%` retrieval recall on a seeded 100-question sample spanning
  two-, three-, and four-hop questions.

These are architecture experiments, not a current leaderboard claim; answering
models, agent behavior, samples, and metrics also affect end-to-end scores.

## Requirements

- **PostgreSQL 18** with these extensions installed in `public`:
  [`pgvector`](https://github.com/pgvector/pgvector),
  [`pg_textsearch`](https://github.com/timescale/pg_textsearch), and `ltree`.
  `pg_textsearch` must be included in `shared_preload_libraries`.
- **Node ≥ 22** or **Bun ≥ 1.4**.

`ensureExtensions()` installs missing extensions into `public` when its database
role has the necessary privileges; `createIndex()` verifies they are installed.
The repository includes a PostgreSQL Dockerfile with the
extensions configured. See **[Install searchgres.js](https://github.com/timescale/searchgres-js/blob/main/docs/installation.md)**.

## Reference implementations

The core library is the primary product. This repository also contains
one maintained compiled `searchgres` CLI with direct PostgreSQL access, embedding
workers, and `searchgres mcp` stdio tools. It is optional: you do not need it to
use the library, and its interfaces do not constrain applications built on core.
There is no searchgres.js HTTP server or remote client to deploy.

The Docker Compose stack runs PostgreSQL, a local Ollama model, initialization,
and an embedding worker for a no-API-key evaluation:

```bash
git clone https://github.com/timescale/searchgres-js.git
cd searchgres-js
docker compose up --build
```

See **[Reference implementations and evaluation tools](https://github.com/timescale/searchgres-js/blob/main/docs/reference-applications.md)**
for component roles and support boundaries, or start with the
**[Docker Compose evaluation guide](https://github.com/timescale/searchgres-js/blob/main/docs/guides/docker-compose.md)**.
The evaluation database and Ollama endpoint are unauthenticated and
loopback-bound. Never expose them to an untrusted network. The host CLI connects
to both directly; see the guide for build, configuration, and search commands.

## Documentation

### Learn the core library

- [Get started](https://github.com/timescale/searchgres-js/blob/main/docs/getting-started.md)
- [How search works](https://github.com/timescale/searchgres-js/blob/main/docs/concepts/how-search-works.md)
- [Model records](https://github.com/timescale/searchgres-js/blob/main/docs/concepts/record-model.md)
- [Architecture and responsibilities](https://github.com/timescale/searchgres-js/blob/main/docs/concepts/architecture.md)
- [Create and manage indexes](https://github.com/timescale/searchgres-js/blob/main/docs/guides/indexes.md)
- [Ingest records](https://github.com/timescale/searchgres-js/blob/main/docs/guides/ingest.md)
- [Generate embeddings](https://github.com/timescale/searchgres-js/blob/main/docs/guides/embeddings.md)
- [Search and filter](https://github.com/timescale/searchgres-js/blob/main/docs/guides/search.md)
- [Build a RAG retriever](https://github.com/timescale/searchgres-js/blob/main/docs/guides/rag.md)
- [Manage records and trees](https://github.com/timescale/searchgres-js/blob/main/docs/guides/records-and-trees.md)
- [Run in production](https://github.com/timescale/searchgres-js/blob/main/docs/guides/production.md)

### Examples and evaluation

- [Runnable core-library examples](https://github.com/timescale/searchgres-js/tree/main/examples)
- [Choosing searchgres.js](https://github.com/timescale/searchgres-js/blob/main/docs/comparison.md)
- [Reference implementations and evaluation tools](https://github.com/timescale/searchgres-js/blob/main/docs/reference-applications.md)
- [Evaluate with Docker Compose](https://github.com/timescale/searchgres-js/blob/main/docs/guides/docker-compose.md)

### Reference

- [API reference](https://github.com/timescale/searchgres-js/blob/main/docs/reference/api.md)
- [Errors and recovery](https://github.com/timescale/searchgres-js/blob/main/docs/reference/errors.md)
- [Direct SQL](https://github.com/timescale/searchgres-js/blob/main/docs/reference/sql.md)

## License

[Apache 2.0](https://github.com/timescale/searchgres-js/blob/main/LICENSE)

searchgres.js is derived from the search engine core of
[Memory Engine](https://github.com/timescale/memory-engine). See the
[NOTICE](https://github.com/timescale/searchgres-js/blob/main/NOTICE).
