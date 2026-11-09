# Generate embeddings

A record is searchable by keyword and filters the moment you write it. Semantic
search needs its embedding vector, and searchgres.js generates those
**asynchronously** by default: a write enqueues the work, and a drainer produces
the vector afterward.

This keeps writes fast and decouples ingestion from your embedding provider — but
it means you must drain the queue (once, or continuously) before new records
appear in semantic results.

## The lifecycle

1. You write a record without a vector.
2. A database trigger enqueues embedding work for it.
3. A drainer claims the work, calls your embedding model, and writes the vector.
4. The record now participates in semantic search and the semantic arm of hybrid.
   It could already match the BM25 arm before embedding.

You choose how step 3 runs: a bounded pass on demand, or a continuous worker.

## Choose an embedding model

`openIndex()` takes an AI SDK embedding model object. The examples use
`openai.embedding("text-embedding-3-small")` from `@ai-sdk/openai`. For another
OpenAI-compatible endpoint, such as a local Ollama server or a self-hosted
proxy, create a provider with its own base URL and use its `embedding()` method
(`embeddingModel()` is the same method under a longer name):

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { openIndex } from "searchgres";

const local = createOpenAI({
  baseURL: "http://127.0.0.1:11434/v1", // the complete API root
  apiKey: process.env.LOCAL_EMBEDDING_API_KEY ?? "unused",
});

const index = await openIndex(sql, "docs_index", {
  embedding: local.embedding("nomic-embed-text"),
});
```

The provider sends an API key on every request. If you omit `apiKey`, it reads
`OPENAI_API_KEY` and fails when that variable is not set. For a server that
ignores the key, pass any placeholder string. The index `dimensions` must match
the model output (`nomic-embed-text` produces 768-dimensional vectors).

Pass a model object, not a model id string. `openIndex()` rejects a string such
as `"text-embedding-3-small"` with `InvalidConfigError`, because the AI SDK
sends a string id to its global default provider, which is the Vercel AI
Gateway unless your application sets another one.

The default batch size comes from the model (see [Tuning](#tuning)). For
`@ai-sdk/openai` models that is 2,048 inputs per provider call, which can
overload a local or self-hosted server. Set `batchSize` explicitly for those
endpoints; 16 to 64 is a reasonable starting point to tune from.

## Supplying a vector yourself

If you already have a vector, pass it and no queue work is created:

```ts
await index.upsert({
  content: "Maintenance window begins at 14:30 UTC.",
  tree: "docs.ops",
  embedding: [/* exactly index.dimensions finite numbers */],
});
```

You can also supply a vector later, with no content change; searchgres.js keeps it
and discards any queued work that referred to the old state, so a drainer can
never overwrite it.

If every vector comes from your own pipeline, the handle never needs a model:
open it with `noEmbedding` (see [Credential separation](#credential-separation)).

## Drain on demand

Run one bounded pass — ideal for a cron job, after a bulk import, or in a
serverless function:

```ts
const result = await index.processEmbeddings({
  batchSize: 50,          // rows per provider call (clamped to the model's max)
  maxBatches: 10,         // stop after this many batches
  maxDurationMs: 30_000,  // stop after this long
  signal,                 // optional AbortSignal, checked before each batch
});

result;
// { claimed, embedded, failed, cancelled, remaining, sampleError }
```

With no bounds it drains until no claimable work remains, then returns.

The result fields:

- **`embedded`** — vectors written back successfully.
- **`failed`** — provider or write-back failures this pass. These rows stay
  pending and retry after their lease; they become terminally `failed` only once
  their attempts are exhausted.
- **`cancelled`** — rows dropped because the record changed or was deleted (their
  work was stale).
- **`remaining`** — rows still pending after the pass.
- **`sampleError`** — the first error that made rows fail in this pass, or
  `null`. Use it to see why a pass failed, for example a mistyped model id. A
  provider failure is an `EmbeddingProviderError` whose `cause` is the AI SDK
  error. It can contain provider text, so redact it before you show it to
  untrusted users.

A provider **rate limit** aborts the pass by throwing
[`RateLimitError`](../reference/errors.md) after it releases the claimed rows
and refunds their attempts, so the work stays pending for a later retry.

A **wrong vector dimension** aborts the pass by throwing
[`DimensionMismatchError`](../reference/errors.md). The model returns vectors
that the index cannot store, and a retry with the same model cannot succeed. So
the claimed batch fails permanently at once, with no retries: its rows appear in
`queueStats().failed` and `listEmbeddingFailures()`. The pass claims no more
rows, and the rest of the queue stays pending. Fix the model or the index, then
[retry the failures](#inspect-and-retry-terminal-failures).

## Run a continuous worker

For steady ingestion, run a background worker:

```ts
import { SearchgresError } from "searchgres";

const worker = index.startEmbeddingWorker({
  intervalMs: 1_000,             // poll delay when idle
  batchSize: 50,
  pruneRetentionMs: 604_800_000, // prune terminal rows when idle (7 days)
  onError(error, { phase, consecutiveErrors, backoffMs, stopped }) {
    // Do not send raw provider/driver diagnostics to an unrestricted log.
    const code = error instanceof SearchgresError ? error.code : "INTERNAL";
    logger.error(
      { code, phase, consecutiveErrors, backoffMs, stopped },
      "embedding worker",
    );
  },
});

// on shutdown — finishes the in-flight batch, then stops.
await worker.stop();
```

The worker processes a batch, immediately continues while work exists, and
sleeps `intervalMs` when idle. `stop()` is graceful: it interrupts the idle wait,
lets any in-flight batch finish, and never closes your pool.

**Pass `onError` and monitor the queue.** The callback reports faults that escape
a drain pass, such as a database failure or a wrong-dimension model
(`DimensionMismatchError`). For most of these, the worker backs off
exponentially (up to 60s) and retries the failed pass. Idle-prune failures are
reported too, but do not fail the drain pass. Process termination and fatal
failures outside the guarded loop still stop the worker.

A `DimensionMismatchError` stops the worker. The rows of that batch fail
permanently (see [Drain on demand](#drain-on-demand)), the callback gets
`stopped: true`, and the worker claims no more work. A retry with the same model
cannot succeed. Fix the configuration, retry the failures, and start a new
worker with a corrected handle. `stop()` still resolves normally.

The callback receives the error plus `phase` (`process` for a drain pass, `prune`
for idle pruning), `consecutiveErrors`, the `backoffMs` before the next tick,
and `stopped`.
A `RateLimitError` is reported with the provider's retry delay (or the default
backoff), and does not count toward `consecutiveErrors`. Call `worker.stop()`
from inside it if you would rather give up than retry. A throwing callback is
ignored.

Ordinary provider failures, including rejected credentials and transient network
errors during embedding, do not reach `onError`. They are recorded on the queue
rows (`last_error`) and retried under the queue's attempt policy. Monitor
[`queueStats()`](#monitor-the-queue) and
[`listEmbeddingFailures()`](#inspect-and-retry-terminal-failures) as well: a
worker can be running without callback errors while embedding work is failing.
Terminal classification follows the visibility-expiry sweep described below.

Multiple workers or processes can drain one index concurrently. Claims use
`FOR UPDATE SKIP LOCKED` and a visibility lease, not exactly-once provider
execution: after a lease expires, another worker can retry a row even if the
original provider call is still running. Write-back is fenced against changed
record inputs and already-finalized queue rows. Size `leaseDurationMs` for the
whole batch, including tokenization, provider retries, and write-back.

## Monitor the queue

```ts
const stats = await index.queueStats();
// { pending, inFlight, waiting, failed, oldestPendingAt }
```

| Field | Meaning |
| --- | --- |
| `pending` | Rows awaiting a vector (`waiting` + `inFlight`). |
| `inFlight` | Pending rows hidden by an unexpired lease or retry delay; not necessarily an active provider call. |
| `waiting` | Pending rows visible to the next claim; exhausted rows are swept rather than retried. |
| `failed` | Current record versions that exhausted their attempts and still have no vector. |
| `oldestPendingAt` | Enqueue time of the oldest pending row, or `null` when idle. |

A steadily rising `pending` or an old `oldestPendingAt` means your drain capacity
isn't keeping up. A growing `failed` count means current record versions have
exhausted their attempt budget. Inspect those failures rather than re-ingesting
the records: an identical upsert is intentionally a no-op and does not enqueue
fresh work.

Terminal failure is recorded during a claim sweep, not immediately when the
last attempt fails. Attempts increment at claim time; the sweep only finalizes
pending rows whose visibility timeout has expired and whose attempts meet the
claiming drainer's `maxAttempts`. This protects unexpired claims, including a
worker's still-running final attempt. Until a subsequent sweep runs, exhausted
rows remain in `pending` (`inFlight` before visibility expires, then `waiting`)
and are absent from `failed` and `listEmbeddingFailures()`. Inspecting queue
status does not run the sweep.

### Inspect and retry terminal failures

List current unresolved failures in ascending queue-id order:

```ts
const failures = await index.listEmbeddingFailures({ limit: 100 });

for (const failure of failures) {
  logger.error({
    queueId: failure.queueId,
    recordId: failure.recordId,
    attempts: failure.attempts,
    failedAt: failure.failedAt,
  });
}
```

`failure.lastError` contains the stored provider/driver diagnostic and may
include sensitive data. Inspect it only in a trusted environment; redact it
before sending it to logs or other systems (see
[Observability](production.md#observability)).

Each result describes a failed job only while its `contentVersion` is still the
record's current version and the record still lacks a vector. Historical jobs
superseded by changed content or a supplied vector are excluded. To fetch the
next page, pass the last result's `queueId` as `after`.

After correcting a temporary network problem, revoked credential, or provider
configuration, explicitly reset selected failures to pending work:

```ts
const result = await index.retryEmbeddingFailures({
  queueIds: failures.map((failure) => failure.queueId),
});
// { retried, skipped }
```

Retry accepts at most 1,000 unique queue ids. It resets attempts and makes
current failures immediately claimable. `skipped` counts jobs that became stale,
were resolved or pruned, were already retried, or do not exist. Retrying is
version-guarded and never resurrects work for old content.

Rate limits normally do not appear here: searchgres.js refunds those attempts and
leaves the work pending with the provider's backoff. Wrong-dimension output
fails the claimed batch permanently. Retry those rows only after you correct
the model or index configuration.
Terminal retry is for ordinary failures whose underlying cause has been fixed;
do not blindly retry a permanent error.

Failure diagnostics are available only until terminal rows are pruned. Prune
terminal rows manually if you aren't running the worker's idle prune:

```ts
await index.pruneEmbeddingQueue({ retentionMs: 604_800_000 });
```

## Tuning

All durations are milliseconds.

- **`batchSize`** (default: the model's `maxEmbeddingsPerCall`, or `10` when the
  model reports no finite limit). Rows per claim and per provider call. A larger
  value is capped at the model's limit.
- **`leaseDurationMs`** (default `300000`) — how long a claimed row is hidden from
  other drainers. If a drainer crashes, its rows reappear after the lease.
- **`maxAttempts`** (default `3`) — queue-claim attempt threshold used by each
  drainer's sweep, not a limit on provider HTTP requests. Set it per
  `processEmbeddings()` call or when starting a worker; it is not stored in the
  schema. Increasing it does not revive already-terminal rows; use
  `retryEmbeddingFailures()` for those.
- **`pruneRetentionMs`** (default `604800000`) — how long terminal rows are kept.

## Why this is safe

You rarely need to think about it, but the guarantees are worth knowing:

- **Any writer enqueues.** The queue is driven by database triggers, so records
  written by direct SQL or another service are embedded too.
- **The queue owns durable retries.** Within one claim, core calls the AI SDK's
  embedding API with its default retry policy (up to two retries for retryable
  failures). One queue attempt can therefore make multiple provider requests.
  If generation still fails, the queue retains the work for a later attempt.
  Provider calls run outside the claim transaction.
- **Stale vectors can't win.** Every write-back is guarded by the record's
  version, so a vector generated for an old version of a record is discarded
  rather than overwriting a newer one.

## Credential separation

Because the queue lives in the database, a process that only writes records needs
no embedding credentials at all. Open it with `noEmbedding`:

```ts
import { noEmbedding, openIndex } from "searchgres";

const ingest = await openIndex(sql, "docs_index", { embedding: noEmbedding });
await ingest.upsertMany(records); // queues embedding work as usual
```

Such a handle can write, read, run keyword and filter search, search by a
precomputed `vector`, inspect the queue, and reset selected terminal failures.
Anything that would have to call a model — `search({ semantic })`,
`processEmbeddings()`, `startEmbeddingWorker()` — throws
`EmbeddingUnavailableError` without touching the queue. A separate
process — the one that opens the index with an embedding model — drains it. See
[Run in production](production.md).

Next: [Search and filter](search.md).
