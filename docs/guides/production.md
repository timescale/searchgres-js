# Run in production

searchgres.js is a library over a database you operate. This guide covers the
operational concerns that go beyond a single process.

## Shutdown

searchgres.js never closes the caller-owned database connection. Close it after
application work finishes:

```ts
await sql.end();
```

If you run a background embedding worker, stop it first so its in-flight batch
can finish:

```ts
await worker.stop();
await sql.end();
```

## Separate ingestion from embedding

Because embedding work lives in a database queue, you can split responsibilities:

- **Ingestion processes** write records and need no embedding credentials at all:
  open the index with
  [`noEmbedding`](embeddings.md#credential-separation).
- **An embedding process** opens the index with a real `EmbeddingModel` and
  drains the queue.

This keeps provider keys off your write path and lets you scale embedding
independently. Multiple drainers can run concurrently against one index using
lease-based claims and fenced write-back. A lease expiry or retry can repeat a
provider call; this is not exactly-once embedding execution. See the
[worker lifecycle](embeddings.md#run-a-continuous-worker).

Choose a drain strategy:

| Strategy | How | Good for |
| --- | --- | --- |
| Cron / scheduled | `processEmbeddings({ maxDurationMs })` per run | Bursty or batch ingestion |
| Serverless | `processEmbeddings({ maxBatches, signal })` | Event-driven pipelines |
| Long-running worker | `startEmbeddingWorker()` | Steady, low-latency indexing |

## Monitor the queue

Track [`queueStats()`](embeddings.md#monitor-the-queue) and alert on:

- **`pending` trending up** or a stale **`oldestPendingAt`** — drain capacity is
  behind ingestion.
- **`failed` rising** — current record versions exhausted their embedding
  attempts and still have no vector; list and diagnose them.

```ts
const { pending, failed, oldestPendingAt } = await index.queueStats();

const failures = await index.listEmbeddingFailures({ limit: 100 });
```

After correcting the underlying transient provider, credential, or network
problem, reset selected rows explicitly:

```ts
await index.retryEmbeddingFailures({
  queueIds: failures.map((failure) => failure.queueId),
});
```

Do not use identical re-ingestion as recovery: an unchanged upsert is a no-op
and does not enqueue new work. See
[Inspect and retry terminal failures](embeddings.md#inspect-and-retry-terminal-failures)
for pagination, retry, and pruning semantics.

If you run `startEmbeddingWorker()`, pass
[`onError`](embeddings.md#run-a-continuous-worker) to observe thrown drain-pass
faults (such as wrong dimensions or database failures), rate limits, and
idle-prune failures. Ordinary provider failures, including a revoked key, are
recorded on queue rows without invoking the callback. Monitor queue backlog and
terminal failures as well; `onError` alone is not a provider-health check.
Terminal failures appear only after visibility expires and another claim sweep
runs, so do not alert only on the terminal count.

Prune terminal rows periodically if you don't run the worker's idle prune:

```ts
await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Observability

searchgres.js is instrumented with the OpenTelemetry API. If your application
registers an OTel SDK, every public operation that performs I/O creates an
`INTERNAL` parent span. Without an SDK the spans are non-recording, nothing is
exported, and only minimal OTel API and wrapper overhead remains.

Operation spans use the `searchgres` instrumentation scope and stable names:

| Area | Span names |
| --- | --- |
| Index | `searchgres.index.create`, `searchgres.index.migrate`, `searchgres.index.open`, `searchgres.index.drop` |
| Records | `searchgres.record.upsert`, `searchgres.record.upsert_many`, `searchgres.record.insert`, `searchgres.record.insert_many`, `searchgres.record.get`, `searchgres.record.get_by_name`, `searchgres.record.patch`, `searchgres.record.delete`, `searchgres.record.delete_by_name` |
| Search | `searchgres.search` |
| Tree | `searchgres.tree.move`, `searchgres.tree.copy`, `searchgres.tree.delete`, `searchgres.tree.count`, `searchgres.tree.list`, `searchgres.tree.view` |
| Embeddings | `searchgres.embedding.generate`, `searchgres.embedding.process`, `searchgres.embedding.queue.stats`, `searchgres.embedding.queue.prune`, `searchgres.embedding.failure.list`, `searchgres.embedding.failure.retry`, `searchgres.embedding.worker.start`, `searchgres.embedding.worker.stop` |

Every operation carries `searchgres.index.schema`. Single-record operations
also carry `searchgres.record.id` once a valid UUIDv7 is known. Depending on the
operation, spans may include `searchgres.batch.size`, `searchgres.result.count`,
`searchgres.search.mode`, `searchgres.tree.dry_run`, index vector shape, or
embedding outcome counts. Normal operation attributes deliberately exclude bulk
ID arrays, record names, tree paths, query text, filters, content, metadata,
vectors, provider credentials, and SQL parameter values. This is not a guarantee
that error diagnostics are free of those values; see the warning below.

Core SQL executed through the internal wrapper emits a `CLIENT` child span with
parameterized statement text and timing under the dedicated `searchgres/sql`
instrumentation scope. The `searchgres.sql=true` marker lets an SDK processor or sampler target
that detail independently. Operation and SQL spans inherit the caller's active
context; otherwise the operation begins a new trace.

`startEmbeddingWorker()` emits a short, non-active startup span, then detaches
the background loop from the caller's trace. Every worker tick begins a new
`searchgres.embedding.process` trace, and `worker.stop()` emits a short span
covering graceful shutdown. A drain pass that throws gets `ERROR` status with
the exception recorded. An ordinary provider failure absorbed by the pass (the
diagnostic is recorded while rows stay pending) is an `embedding.batch_failed`
event on an otherwise successful span.

Every rejected public operation records the exception, sets `ERROR`, and adds
`error.type`; typed searchgres.js errors also add `searchgres.error.code`. SQL
failures are therefore visible on both the SQL child and caller-level operation
span.

**Treat error telemetry as sensitive.** Core records exception messages and stack
traces, and `embedding.batch_failed` includes a bounded provider diagnostic.
Those diagnostics and SQL error status descriptions can contain content,
credentials, connection details, or other values echoed by a provider or driver.
They are not covered by the normal-attribute exclusions above. Restrict access
and retention in telemetry backends, and redact or remove exception/event
attributes and status descriptions in your processor or exporter before sending
them outside a trusted boundary. Apply the same policy to queue `lastError`
diagnostics and application logging. CLI/MCP output redaction is separate and
does not sanitize core telemetry.

## Access control

searchgres.js has no user, account, or authorization model. The surrounding
application authenticates callers and can translate identity into mandatory
`tree` or `meta` filters:

```ts
const tenantScope = { tree: `tenants.${trustedTenantLabel}` } as const;
const filter = requestFilter
  ? { and: [tenantScope, requestFilter] as const }
  : tenantScope;

const hits = await index.search({
  semantic: query,
  fulltext: query,
  filter,
});
```

This is an authorization boundary only when the application constructs the
final filter and the caller cannot access an unscoped index handle or issue
unrestricted SQL. Never trust a caller merely to include its own tenant filter.
Validate or map external tenant identifiers to legal `ltree` labels rather than
interpolating them directly.

Database roles and grants provide another boundary. The index's SQL routines run
as `security invoker`, so they act with the calling role's privileges. Grant each
role only what it needs, and use separate indexes or database-level policy when
your threat model requires stronger physical or database enforcement.

See [Architecture and responsibilities](../concepts/architecture.md#access-control-with-composable-filters).

### Roles for the direct reference CLI/MCP

Provision with a separate owner/admin role. Do not give a local MCP process the
schema owner's credentials merely because the evaluation stack does. The
binary does not manage database identities; select credentials through its
configured database URL environment variable.

For an existing index named `docs`, a database administrator can grant a
pre-existing runtime role the following baseline privileges:

```sql
GRANT USAGE ON SCHEMA docs TO searchgres_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA docs TO searchgres_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA docs TO searchgres_runtime;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA docs TO searchgres_runtime;
```

The role also needs database `CONNECT` and access to the extensions in `public`.
These grants support writes, queue processing, and triggers but not provisioning
or dropping the schema. Review inherited/PUBLIC privileges and memberships;
these grants do not revoke previously granted access to other indexes. In a
hardened database, revoke default public routine execution for the index and
grant only the required roles. Set role login credentials/TLS through your
normal database administration, not checked-in SQL or CLI tool inputs.

For a separate read-only role, grant only schema usage, table SELECT, and the
needed routine EXECUTE privileges; do not inherit the writer role. Use
`searchgres mcp --read-only` to omit write tools and disable workers as well.
Routine execution does not bypass underlying table privileges because core
routines are security invoker. Read-only semantic search still needs provider
credentials. Neither tool annotations nor caller-supplied filters replace
PostgreSQL permissions.

## Reindexing and cutover

Index shape (dimensions, vector type) is immutable, and switching embedding
models requires re-embedding. Rebuild into a new schema and perform a controlled
cutover:

1. Create a new index schema with the new shape.
2. Backfill records into it from your source of truth.
3. Drain embeddings.
4. Validate search quality.
5. Switch application traffic to the new schema name.
6. Drop the old index.

To avoid an interruption while writes continue during backfill, the application
must account for those concurrent changes—for example with dual writes or a
final change-data catch-up before switching traffic. searchgres.js does not
coordinate that application-level migration.

The step-by-step version is in
[Create and manage indexes](indexes.md#rebuild-and-cut-over).

## Backups and recovery

An index is ordinary PostgreSQL data in a schema you named. It is covered by your
normal backup, point-in-time recovery, and replication setup — nothing
searchgres.js-specific is required. Records with missing vectors are simply
re-embedded by draining the queue after a restore.
