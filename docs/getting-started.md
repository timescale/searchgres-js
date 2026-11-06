# Get started

This guide takes you from an empty PostgreSQL database to working semantic,
keyword, and hybrid search with the core TypeScript library. It should take a
few minutes. To evaluate the optional direct CLI and MCP tools without writing
code instead, use the [Docker Compose guide](guides/docker-compose.md).

You will:

1. run PostgreSQL with the required extensions,
2. create an index,
3. write some records,
4. generate their embeddings,
5. run semantic, keyword, and hybrid searches.

## Prerequisites

- Node 22+ (or Bun 1.4+)
- A PostgreSQL 18 database with the `vector`, `pg_textsearch`, and `ltree`
  extensions available. If you don't have one, see
  [Install searchgres.js](installation.md) for a one-command Docker setup.
- An embedding provider. This guide uses OpenAI via the AI SDK; any provider
  works.

Install the packages:

```bash
npm install searchgres postgres@3 @ai-sdk/openai
```

Set your connection string and provider key:

```bash
export DATABASE_URL="postgres://postgres@127.0.0.1:5432/postgres"
export OPENAI_API_KEY="sk-..."
```

## 1. Connect

You create and own the database connection. searchgres.js never opens or closes it.

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL);
```

## 2. Create an index

An index is a PostgreSQL schema that holds your records and their search
indexes. Create it once. `dimensions` must match your embedding model —
`text-embedding-3-small` produces 1536-dimensional vectors.

```ts
import { createIndex, ensureExtensions } from "searchgres";

await ensureExtensions(sql);
await createIndex(sql, "docs_index", { dimensions: 1536 });
```

## 3. Open it

Opening returns a handle you use for everything else. You supply the embedding
model here. The OpenAI provider package reads `OPENAI_API_KEY` when it makes a
request; searchgres.js receives the model object rather than provider credential
configuration. Provider error diagnostics can still echo sensitive values; see
[telemetry precautions](guides/production.md#observability).

```ts
import { openIndex } from "searchgres";
import { openai } from "@ai-sdk/openai";

const index = await openIndex(sql, "docs_index", {
  embedding: openai.embedding("text-embedding-3-small"),
});
```

## 4. Write records

One record is one chunk of searchable text. Give each a `tree` path to organize
it, optional `meta` for filtering, and an optional `temporal` value to place it
in time. `temporal` is a tuple: `[instant]` for a point in time, or
`[start, end]` for a half-open interval. Each timestamp is either a `Date` or an
ISO 8601 string that carries an explicit UTC offset (`Z` or `±hh:mm`) — an
offset-less string is rejected rather than being silently read in the server's
time zone.

```ts
await index.upsertMany([
  {
    content: "Auth tokens are rotated every 24 hours by the scheduler.",
    tree: "docs.auth",
    meta: { source: "runbook" },
    temporal: [new Date("2026-01-15T00:00:00Z")], // documented on this date
  },
  {
    content: "Rate limits are enforced per API key at 100 requests per minute.",
    tree: "docs.api",
    meta: { source: "runbook" },
    // A string with an explicit offset works too.
    temporal: ["2026-02-01T00:00:00Z", "2026-03-01T00:00:00Z"], // valid window
  },
]);
```

You can later filter searches to a point or range in time — see
[Search and filter](guides/search.md).

## 5. Generate embeddings

Records are searchable by keyword and filters immediately. Semantic search needs
their vectors, which are generated asynchronously. Drain the queue once:

```ts
await index.processEmbeddings();
```

In production you would usually run a background worker instead — see
[Generate embeddings](guides/embeddings.md).

## 6. Search

**Semantic** search finds related meaning even when the words differ:

```ts
const semantic = await index.search({
  semantic: "how often do credentials change?",
  limit: 5,
});
console.log(semantic[0]?.content);
// "Auth tokens are rotated every 24 hours by the scheduler."
```

**Keyword** search (BM25) finds exact terms:

```ts
const keyword = await index.search({ fulltext: "rate limit" });
```

**Hybrid** search runs both and fuses the rankings — pass a semantic arm and
`fulltext` together:

```ts
const hybrid = await index.search({
  semantic: "how are request limits enforced?",
  fulltext: "rate limit",
  limit: 5,
});
```

Every result is the full record plus a `score`:

```ts
for (const hit of hybrid) {
  console.log(hit.score, hit.tree, hit.content);
}
```

## 7. Clean up

Close the connection you created when your program exits:

```ts
await sql.end();
```

## What next?

- [How search works](concepts/how-search-works.md) — BM25, vectors, RRF,
  filters, scores, and candidate windows.
- [Model records](concepts/record-model.md) — chunking, hierarchy, metadata,
  temporal values, and derived records.
- [Search and filter](guides/search.md) — scope searches by tree, metadata,
  time, and regex.
- [Build a RAG retriever](guides/rag.md) — add trusted scope and format records
  as model context.
- [Generate embeddings](guides/embeddings.md) — run a continuous worker and
  monitor the queue.
- [Run in production](guides/production.md) — deployment and operations.
