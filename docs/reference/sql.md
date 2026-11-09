# Direct SQL

> **Advanced and optional.** Most applications should use the TypeScript library.
> This page is for tools and services that query the database directly — a
> reporting job, a data pipeline, or a non-TypeScript service.

Each index provisions a set of routines in its own schema. They are `security
invoker` (they run with the calling role's privileges) and callable with plain
SQL. The library calls exactly these routines, so direct callers get the same
behavior.

Replace `docs_index` with your index's schema name throughout.

## A note on types

Extension types and operators are referenced with a literal `public` schema, so
your session's `search_path` doesn't matter. In your own calls, cast vectors to
the type your index was created with — `public.halfvec` (the default) or
`public.vector`:

```sql
'[0.01, 0.02, ...]'::public.halfvec   -- for a halfvec index
'[0.01, 0.02, ...]'::public.vector    -- for a vector index
```

## Reading records

```sql
-- by id
select * from docs_index.get_record('019ce89d-f8b4-7000-8000-000000000001');

-- by (tree, name)
select * from docs_index.get_record_by_name('docs.api'::public.ltree, 'rate-limits');
```

Both return the full record columns (`id, content, meta, tree, temporal, name,
has_embedding, version, version_hash, created_at, updated_at`) and zero rows when
nothing matches.

## Writing records

`batch_upsert` takes parallel arrays (one element per record) plus a conflict
mode (defaulting to `replace`), and returns one `(ord, id, status)` row per input in order.

```sql
select ord, id, status
from docs_index.batch_upsert(
  array[null]::uuid[],                    -- ids (null → generated UUIDv7)
  array['First record']::text[],          -- contents
  '[{}]'::jsonb,                          -- one JSON object per record (meta)
  array['docs.example']::public.ltree[],  -- trees
  array[null]::tstzrange[],               -- temporals
  array['intro']::text[],                 -- names (null → unnamed)
  array[null]::public.halfvec[],          -- embeddings (null → queued)
  'error'                                 -- 'error' | 'ignore' | 'replace'
);
```

It raises `unique_violation` (SQLSTATE `23505`) for an `error`-mode conflict and
`invalid_parameter_value` (`22023`) for malformed input (mismatched array
lengths, duplicate keys, or an id and name that target the same existing record).

Writes without a supplied embedding are queued for embedding automatically — the
trigger fires for any writer, including direct `INSERT`s into the record table.

## Patching and deleting

```sql
select *
from docs_index.patch_record(
  '019ce89d-...'::uuid,        -- id
  '<prior version_hash>',      -- optimistic-concurrency guard
  '{"content": "new text"}'::jsonb,
  null::public.halfvec         -- optional replacement embedding
);
-- found=false → not found; found=true, updated=false → stale version_hash

select docs_index.delete_record('019ce89d-...'::uuid);
select docs_index.delete_record_by_name('docs.api'::public.ltree, 'rate-limits');
-- delete many by id; returns the number of rows removed (missing ids add 0)
select docs_index.delete_records(array['019ce89d-...']::uuid[]);
```

## Tree operations

```sql
select docs_index.move_tree('drafts'::public.ltree, 'published'::public.ltree, false);
select docs_index.copy_tree('templates'::public.ltree, 'docs.new'::public.ltree, false);
select docs_index.delete_tree('scratch'::public.ltree, false);  -- last arg: dry-run

-- counts (second arg caps the scan; null = no cap)
select docs_index.count_tree('docs.api'::public.ltree, null);
select docs_index.count_tree('docs.*'::public.lquery, null);
select docs_index.count_tree('api & v2'::public.ltxtquery, null);

-- per-node descendant counts
select tree, count from docs_index.list_tree('docs.*'::public.lquery);
```

## Searching

`search_records` handles filter-only, keyword, and semantic queries.
`hybrid_search_records` fuses a keyword and a semantic arm with RRF. Both return
the full record columns plus `score`.

```sql
-- keyword
select id, content, score
from docs_index.search_records(_fulltext => 'rate limit', _limit => 20);

-- semantic (cast the vector to your index's type)
select id, content, score
from docs_index.search_records(
  _vec => '[0.01, ...]'::public.halfvec,
  _limit => 10
);

-- hybrid, scoped by a filter
select id, content, score
from docs_index.hybrid_search_records(
  _fulltext => 'rate limit',
  _vec => '[0.01, ...]'::public.halfvec,
  _filter => '{"tree": "docs.api"}'::jsonb
);
```

The `_filter` argument is the same boolean-AST JSON the library builds (see
[Search and filter](../guides/search.md)); its values are always bound as data.
Malformed filters raise `invalid_parameter_value` (`22023`).

`search_records` accepts either a keyword arm (`_fulltext`) or a semantic arm
(`_vec`), not both — use `hybrid_search_records` for both. Filter-only listing
supports `_order`, `_after`, and `_before`.

## Embedding queue

Embedding generation runs outside PostgreSQL, coordinated by schema-local queue
routines (`idempotent/005_embedding_queue.sql`):

```sql
-- claim up to 10 rows with a 5-minute lease and 3 max attempts
select queue_id, record_id, content_version, content, claimed
from docs_index.claim_embedding_batch(10, interval '5 minutes', 3);

-- version-fenced write-back after generating the vector outside the transaction
select docs_index.complete_embedding(
  1,
  '019ce89d-...'::uuid,
  1,
  '[0.01, ...]'::public.halfvec
);

-- record a transient provider error or release a claim after a 429 rate limit
select docs_index.fail_embedding(1, 'provider timeout');
select docs_index.release_embedding(1, interval '5 seconds');

-- fail a claim at once, with no retry (for example a wrong vector dimension)
select docs_index.fail_embedding_permanently(1, 'dimension mismatch');

-- inspect, retry failures, and prune terminal rows
select * from docs_index.embedding_queue_stats();
select docs_index.pending_embedding_count();
select * from docs_index.list_embedding_failures(100, null);
select docs_index.retry_embedding_failures(array[1]::bigint[]);
select docs_index.prune_embedding_queue(interval '7 days');

```

The library's `processEmbeddings()` and `startEmbeddingWorker()` orchestrate
this loop with your configured embedding model. See
[Generate embeddings](../guides/embeddings.md).

## Stability

These routine signatures are part of the index's schema format (`3`), not the
npm package version. Multiple package releases may support the same format.
When a new schema format updates the routines, upgrade existing format-`2` or
later indexes during a maintenance window with `migrateIndex(sql, schema)` or
`searchgres migrate`.
