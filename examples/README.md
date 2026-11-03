# searchgres.js examples

These examples use the published core library directly. They do not require the
optional CLI/MCP binary, so the application/library boundary is visible.

| Example | Demonstrates |
| --- | --- |
| [basic-search](basic-search/) | Create, ingest, embed, and run filtered hybrid search |
| [rag-retriever](rag-retriever/) | A scoped retrieval function and local context formatting |
| [document-search](document-search/) | Stable chunks, tree organization, metadata, and derived records |
| [temporal-search](temporal-search/) | Events, periods, and temporal filters |
| [worker](worker/) | A separate continuous embedding worker process |

All examples expect:

- PostgreSQL 18 with `vector`, `pg_textsearch`, and `ltree` available in
  `public`;
- `pg_textsearch` in `shared_preload_libraries`;
- `DATABASE_URL` and `OPENAI_API_KEY` in the environment;
- an index whose dimensions match `text-embedding-3-small`.

From an example directory:

```bash
npm install searchgres postgres @ai-sdk/openai
node index.ts
```

Running TypeScript directly requires Node 22.18 or newer. Alternatively use Bun
or your application's TypeScript build.

The four create-and-search programs use a unique temporary schema for each run
and drop it in `finally`, including when a later operation fails. They are safe
to repeat and run concurrently. The worker example is intentionally different:
it opens the existing `application_search` index owned by the application and
never creates or drops it.
