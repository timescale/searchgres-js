import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { noEmbedding } from "../src/embedding.ts";
import type { WorkerErrorContext } from "../src/embedding-worker.ts";
import {
  DimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  InvalidInputError,
  RateLimitError,
} from "../src/errors.ts";
import { type Index, openIndex } from "../src/open-index.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import {
  type ControllableEmbeddingModel,
  controllableEmbeddingModel,
  rateLimitError,
} from "./support/embedding.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(
  fn: (index: Index, model: ControllableEmbeddingModel) => Promise<void>,
  model: ControllableEmbeddingModel = controllableEmbeddingModel(),
): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: model });
    await fn(index, model);
  } finally {
    await dropTestSchema(sql, schema);
  }
}

interface QueueRow {
  readonly id: string;
  readonly content_version: number;
  readonly attempts: number;
  readonly outcome: string | null;
  readonly last_error: string | null;
  readonly visible_future: boolean;
}

async function queueRows(schema: string): Promise<readonly QueueRow[]> {
  return sql<QueueRow[]>`
    select id::text, content_version, attempts, outcome, last_error,
           (visible_at > now()) as visible_future
    from ${sql(schema)}.embedding_queue
    order by id
  `;
}

async function embeddingOf(schema: string, id: string): Promise<string | null> {
  const [row] = await sql<{ embedding: string | null }[]>`
    select embedding from ${sql(schema)}.record where id = ${id}
  `;
  return row?.embedding ?? null;
}

async function contentVersionOf(schema: string, id: string): Promise<number> {
  const [row] = await sql<{ content_version: number }[]>`
    select content_version from ${sql(schema)}.record where id = ${id}
  `;
  assert.ok(row);
  return row.content_version;
}

test("embedding write-back preserves record version and updatedAt", async () => {
  await withIndex(async (index) => {
    const inserted = await index.upsert({
      content: "versioned",
      tree: "docs",
    });
    const created = await index.get(inserted.id);
    const before = await index.patch(created.id, created.versionHash, {
      meta: { lifecycle: "queued" },
    });
    assert.ok(before.updatedAt);
    assert.equal(before.hasEmbedding, false);
    const beforeContentVersion = await contentVersionOf(
      index.schema,
      created.id,
    );

    const result = await index.processEmbeddings();
    assert.equal(result.embedded, 1);

    const after = await index.get(created.id);
    const afterContentVersion = await contentVersionOf(
      index.schema,
      created.id,
    );
    assert.equal(after.hasEmbedding, true);
    assert.equal(after.version, before.version);
    assert.equal(after.versionHash, before.versionHash);
    assert.ok(after.updatedAt);
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    assert.equal(afterContentVersion, beforeContentVersion + 1);

    // A versioned field still advances every public change signal.
    await sql`select pg_catalog.pg_sleep(0.01)`;
    const changed = await index.patch(after.id, after.versionHash, {
      meta: { lifecycle: "ready" },
    });
    assert.equal(changed.version, "3");
    assert.notEqual(changed.versionHash, after.versionHash);
    assert.ok(changed.updatedAt);
    assert.ok(changed.updatedAt.getTime() > after.updatedAt.getTime());
  });
});

test("noEmbedding supports ingest, precomputed vectors, and lexical search but refuses to embed", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const ingest = await openIndex(sql, schema, { embedding: noEmbedding });

    // Everything that does not generate a vector works.
    const queued = await ingest.upsert({ content: "queued later", tree: "a" });
    const precomputed = await ingest.upsert({
      content: "already embedded",
      tree: "a",
      embedding: [1, 0, 0, 0],
    });
    const byVector = await ingest.search({ vector: [1, 0, 0, 0], limit: 5 });
    assert.deepEqual(
      byVector.map((hit) => hit.id),
      [precomputed.id],
    );
    const byKeyword = await ingest.search({ fulltext: "queued", limit: 5 });
    assert.deepEqual(
      byKeyword.map((hit) => hit.id),
      [queued.id],
    );
    const listed = await ingest.search({ filter: { tree: "a" } });
    assert.equal(listed.length, 2);
    assert.equal((await ingest.queueStats()).pending, 1);
    await ingest.pruneEmbeddingQueue({ retentionMs: 0 });

    // Everything that needs a model throws before doing any work.
    const unavailable = (operation: string) => (error: unknown) =>
      error instanceof EmbeddingUnavailableError &&
      error.operation === operation;
    await assert.rejects(
      () => ingest.search({ semantic: "queued" }),
      unavailable("search by semantic text"),
    );
    await assert.rejects(
      () => ingest.processEmbeddings(),
      unavailable("process embeddings"),
    );
    assert.throws(
      () => ingest.startEmbeddingWorker(),
      unavailable("start the embedding worker"),
    );
    // The queue row was never claimed.
    const [row] = await queueRows(schema);
    assert.ok(row);
    assert.equal(row.attempts, 0);
    assert.equal(row.outcome, null);
    assert.equal(row.visible_future, false);

    // A handle with a real model drains the same queue.
    const model = controllableEmbeddingModel();
    model.handler = (values) => values.map(() => [0, 1, 0, 0]);
    const worker = await openIndex(sql, schema, { embedding: model });
    const result = await worker.processEmbeddings();
    assert.equal(result.embedded, 1);
    assert.equal((await worker.get(queued.id)).hasEmbedding, true);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("processEmbeddings embeds queued rows and writes vectors back", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) =>
      values.map((value) => (value === "alpha" ? [1, 0, 0, 0] : [0, 1, 0, 0]));

    const [a] = await index.upsertMany([
      { content: "alpha", tree: "docs" },
      { content: "beta", tree: "docs" },
    ]);
    assert.equal((await index.queueStats()).pending, 2);

    const result = await index.processEmbeddings();
    assert.deepEqual(result, {
      claimed: 2,
      embedded: 2,
      failed: 0,
      cancelled: 0,
      remaining: 0,
      sampleError: null,
    });

    assert.equal(await embeddingOf(index.schema, a?.id ?? ""), "[1,0,0,0]");
    assert.equal((await index.queueStats()).pending, 0);

    const hits = await index.search({ vector: [1, 0, 0, 0], limit: 5 });
    assert.equal(hits[0]?.content, "alpha");
  });
});

test("processEmbeddings is a no-op on an empty queue", async () => {
  await withIndex(async (index) => {
    const result = await index.processEmbeddings();
    assert.deepEqual(result, {
      claimed: 0,
      embedded: 0,
      failed: 0,
      cancelled: 0,
      remaining: 0,
      sampleError: null,
    });
  });
});

test("a precomputed embedding written after enqueue cancels the stale row", async () => {
  await withIndex(async (index) => {
    const [row] = await index.upsertMany([{ content: "async", tree: "docs" }]);
    const id = row?.id ?? "";
    assert.equal((await index.queueStats()).pending, 1);

    // Direct repair: supply a vector with no content change. record_integrity
    // advances content_version (embedding changed null->vector) without enqueuing
    // new work, leaving the pending row behind the record version.
    await sql`
      update ${sql(index.schema)}.record
      set embedding = ${"[0,1,0,0]"}::public.halfvec
      where id = ${id}
    `;

    const result = await index.processEmbeddings();
    assert.equal(result.claimed, 0);
    assert.equal(result.embedded, 0);
    assert.equal(result.cancelled, 1);
    // The supplied vector must survive — the worker must not overwrite it.
    assert.equal(await embeddingOf(index.schema, id), "[0,1,0,0]");
    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("write-back cancels when content changes during embedding", async () => {
  await withIndex(async (index, model) => {
    const [row] = await index.upsertMany([{ content: "orig", tree: "docs" }]);
    const id = row?.id ?? "";

    // Mutate the record mid-embed: this bumps content_version, so the claimed
    // v1 write-back must cancel rather than install a now-stale vector.
    model.handler = async (values) => {
      await sql`
        update ${sql(index.schema)}.record
        set content = 'changed'
        where id = ${id}
      `;
      return values.map(() => [1, 0, 0, 0]);
    };

    const result = await index.processEmbeddings({ maxBatches: 1 });
    assert.equal(result.embedded, 0);
    assert.equal(result.cancelled, 1);
    // No stale vector installed; the content change re-enqueued fresh work.
    assert.equal(await embeddingOf(index.schema, id), null);
    assert.ok(result.remaining >= 1);
  });
});

test("concurrent drainers never double-embed", async () => {
  await withIndex(async (index) => {
    await index.upsertMany(
      Array.from({ length: 6 }, (_, i) => ({
        content: `row ${i}`,
        tree: "docs",
      })),
    );

    const [first, second] = await Promise.all([
      index.processEmbeddings(),
      index.processEmbeddings(),
    ]);
    assert.equal(first.embedded + second.embedded, 6);
    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("a rate limit refunds attempts, defers visibility, and throws", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw rateLimitError(50);
    };
    await index.upsertMany([{ content: "rl", tree: "docs" }]);

    await assert.rejects(() => index.processEmbeddings(), RateLimitError);

    const [row] = await queueRows(index.schema);
    assert.equal(row?.outcome, null);
    assert.equal(row?.attempts, 0); // refunded
    assert.equal(row?.visible_future, true); // deferred by backoff
  });
});

test("a wrong-dimension model fails the batch permanently and throws", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) => values.map(() => [1, 0, 0]); // dim 3 != 4
    await index.upsertMany([
      { content: "wd one", tree: "docs" },
      { content: "wd two", tree: "docs" },
      { content: "wd three", tree: "docs" },
    ]);

    await assert.rejects(
      () => index.processEmbeddings({ batchSize: 2, maxAttempts: 100 }),
      DimensionMismatchError,
    );

    // Only the claimed batch fails, at once and with no retry budget left.
    // The pass stops, so the third row stays pending for a fixed handle.
    assert.equal(model.batches.length, 1);
    const rows = await queueRows(index.schema);
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ["failed", "failed", null],
    );
    assert.match(rows[0]?.last_error ?? "", /index expects 4, received 3/);
    const failures = await index.listEmbeddingFailures();
    assert.equal(failures.length, 2);

    // After the model is fixed, an explicit retry embeds the failed rows.
    model.handler = (values) => values.map(() => [1, 0, 0, 0]);
    await index.retryEmbeddingFailures({
      queueIds: failures.map((f) => f.queueId),
    });
    const result = await index.processEmbeddings();
    assert.equal(result.embedded, 3);
    assert.equal(result.sampleError, null);
  });
});

test("processEmbeddings returns the first failure as sampleError", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("model nomic-typo not found");
    };
    await index.upsertMany([{ content: "typo", tree: "docs" }]);

    const result = await index.processEmbeddings({ maxBatches: 1 });
    assert.equal(result.failed, 1);
    assert.ok(result.sampleError instanceof EmbeddingProviderError);
    assert.match(
      String((result.sampleError.cause as Error | undefined)?.message),
      /nomic-typo not found/,
    );
  });
});

test("an ordinary failure records last_error, retries, then terminally fails", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("provider boom");
    };
    await index.upsertMany([{ content: "boom", tree: "docs" }]);

    // leaseDurationMs 0 so the row is immediately reclaimable by the sweep;
    // maxBatches 1 so this pass stops before its own sweep finalizes the row.
    const first = await index.processEmbeddings({
      maxAttempts: 1,
      leaseDurationMs: 0,
      maxBatches: 1,
    });
    assert.equal(first.failed, 1);
    assert.equal(first.embedded, 0);
    const [pending] = await queueRows(index.schema);
    assert.equal(pending?.outcome, null);
    assert.match(pending?.last_error ?? "", /provider boom/);
    assert.equal(pending?.attempts, 1);

    // Next pass: attempts exhausted → the claim sweep finalizes it as failed.
    await index.processEmbeddings({ maxAttempts: 1 });
    const stats = await index.queueStats();
    assert.equal(stats.pending, 0);
    assert.equal(stats.failed, 1);
  });
});

test("lists, paginates, and retries current terminal failures", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("temporary network failure");
    };
    await index.upsertMany([
      { content: "failure one", tree: "docs" },
      { content: "failure two", tree: "docs" },
      { content: "failure three", tree: "docs" },
    ]);

    await index.processEmbeddings({
      maxAttempts: 1,
      leaseDurationMs: 0,
      maxBatches: 1,
    });
    await index.processEmbeddings({ maxAttempts: 1 });

    const firstPage = await index.listEmbeddingFailures({ limit: 2 });
    assert.equal(firstPage.length, 2);
    const first = firstPage[0];
    const second = firstPage[1];
    assert.ok(first);
    assert.ok(second);
    assert.ok(BigInt(first.queueId) < BigInt(second.queueId));
    assert.equal(first.contentVersion, 1);
    assert.equal(first.attempts, 1);
    assert.match(first.lastError ?? "", /temporary network failure/);
    assert.ok(first.enqueuedAt instanceof Date);
    assert.ok(first.failedAt instanceof Date);

    const secondPage = await index.listEmbeddingFailures({
      limit: 2,
      after: second.queueId,
    });
    assert.equal(secondPage.length, 1);
    assert.ok(BigInt(secondPage[0]?.queueId ?? "0") > BigInt(second.queueId));

    // Queue administration does not itself generate vectors and is available
    // to credential-separated handles.
    const admin = await openIndex(sql, index.schema, {
      embedding: noEmbedding,
    });
    const retried = await admin.retryEmbeddingFailures({
      queueIds: firstPage.map((failure) => failure.queueId),
    });
    assert.deepEqual(retried, { retried: 2, skipped: 0 });
    assert.equal((await index.queueStats()).pending, 2);
    assert.equal((await index.queueStats()).failed, 1);

    const rows = await queueRows(index.schema);
    for (const row of rows.slice(0, 2)) {
      assert.equal(row.outcome, null);
      assert.equal(row.attempts, 0);
      assert.equal(row.last_error, null);
      assert.equal(row.visible_future, false);
    }

    model.handler = (values) => values.map(() => [0, 1, 0, 0]);
    const drained = await index.processEmbeddings();
    assert.equal(drained.embedded, 2);
    assert.equal((await index.queueStats()).failed, 1);
  });
});

test("stale terminal failures are neither listed nor retried", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("old failure");
    };
    const inserted = await index.upsert({ content: "old", tree: "docs" });
    await index.processEmbeddings({
      maxAttempts: 1,
      leaseDurationMs: 0,
      maxBatches: 1,
    });
    await index.processEmbeddings({ maxAttempts: 1 });
    const [failure] = await index.listEmbeddingFailures();
    assert.ok(failure);
    assert.equal((await index.queueStats()).failed, 1);

    const record = await index.get(inserted.id);
    await index.patch(record.id, record.versionHash, { content: "new" });

    assert.deepEqual(await index.listEmbeddingFailures(), []);
    assert.equal((await index.queueStats()).failed, 0);
    assert.deepEqual(
      await index.retryEmbeddingFailures({ queueIds: [failure.queueId] }),
      { retried: 0, skipped: 1 },
    );
  });
});

test("concurrent embedding-failure retries reset a row only once", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("retry race");
    };
    await index.upsert({ content: "race", tree: "docs" });
    await index.processEmbeddings({
      maxAttempts: 1,
      leaseDurationMs: 0,
      maxBatches: 1,
    });
    await index.processEmbeddings({ maxAttempts: 1 });
    const [failure] = await index.listEmbeddingFailures();
    assert.ok(failure);

    const outcomes = await Promise.all([
      index.retryEmbeddingFailures({ queueIds: [failure.queueId] }),
      index.retryEmbeddingFailures({ queueIds: [failure.queueId] }),
    ]);
    assert.equal(
      outcomes.reduce((total, outcome) => total + outcome.retried, 0),
      1,
    );
    assert.equal(
      outcomes.reduce((total, outcome) => total + outcome.skipped, 0),
      1,
    );
  });
});

test("embedding-failure options are validated", async () => {
  await withIndex(async (index) => {
    await assert.rejects(
      () => index.listEmbeddingFailures({ limit: 0 }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.listEmbeddingFailures({ after: "01" }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.listEmbeddingFailures({ after: "not-an-id" }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.listEmbeddingFailures({ extra: true } as never),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.retryEmbeddingFailures({ queueIds: [] }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.retryEmbeddingFailures({ queueIds: ["1", "1"] }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.retryEmbeddingFailures({ queueIds: ["9223372036854775808"] }),
      InvalidInputError,
    );
  });
});

test("queueStats reports pending, waiting, and failed", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([
      { content: "one", tree: "docs" },
      { content: "two", tree: "docs" },
    ]);
    const stats = await index.queueStats();
    assert.equal(stats.pending, 2);
    assert.equal(stats.waiting, 2);
    assert.equal(stats.inFlight, 0);
    assert.equal(stats.failed, 0);
    assert.ok(stats.oldestPendingAt instanceof Date);
  });
});

test("startEmbeddingWorker drains the queue, then stops gracefully", async () => {
  await withIndex(async (index) => {
    await index.upsertMany(
      Array.from({ length: 4 }, (_, i) => ({
        content: `w ${i}`,
        tree: "docs",
      })),
    );

    const worker = index.startEmbeddingWorker({ intervalMs: 20 });
    try {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await index.queueStats()).pending === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      await worker.stop();
    }

    assert.equal((await index.queueStats()).pending, 0);
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("startEmbeddingWorker reports repeated failures through onError with growing backoff", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw new Error("provider down");
    };
    await index.upsertMany([{ content: "e", tree: "docs" }]);
    const seen: { error: unknown; context: WorkerErrorContext }[] = [];

    const worker = index.startEmbeddingWorker({
      intervalMs: 10,
      leaseDurationMs: 0,
      maxAttempts: 100,
      onError: (error, context) => {
        seen.push({ error, context });
      },
    });
    try {
      // An ordinary provider error is recorded per row, not thrown, so the pass
      // itself succeeds; nothing reaches onError for that path.
      await waitFor(() => model.batches.length >= 2);
      assert.equal(seen.length, 0);
    } finally {
      await worker.stop();
    }

    // A failure that throws from the pass backs off and keeps the worker
    // running. Here the model's batch limit cannot be read.
    const failing = await openIndex(sql, index.schema, {
      embedding: {
        ...model,
        get maxEmbeddingsPerCall(): PromiseLike<number> {
          return Promise.reject(new Error("model metadata unavailable"));
        },
      },
    });
    const backoffWorker = failing.startEmbeddingWorker({
      intervalMs: 10,
      onError: (error, context) => {
        seen.push({ error, context });
      },
    });
    try {
      await waitFor(() => seen.length >= 2);
    } finally {
      await backoffWorker.stop();
    }

    const [first, second] = seen;
    assert.ok(first?.error instanceof Error);
    assert.match(first.error.message, /metadata/);
    assert.equal(first?.context.phase, "process");
    assert.equal(first?.context.consecutiveErrors, 1);
    assert.equal(first?.context.backoffMs, 10);
    assert.equal(first?.context.stopped, false);
    assert.equal(second?.context.consecutiveErrors, 2);
    assert.equal(second?.context.backoffMs, 20);
    assert.equal(second?.context.stopped, false);
  });
});

test("startEmbeddingWorker stops after a wrong-dimension model", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) => values.map(() => [1, 0, 0]);
    await index.upsertMany([
      { content: "wd one", tree: "docs" },
      { content: "wd two", tree: "docs" },
    ]);
    const seen: { error: unknown; context: WorkerErrorContext }[] = [];
    const worker = index.startEmbeddingWorker({
      intervalMs: 10,
      batchSize: 1,
      onError: (error, context) => {
        seen.push({ error, context });
      },
    });
    try {
      await waitFor(() => seen.length >= 1);
      // Give a running worker time to claim again. A stopped one does not.
      await new Promise((resolve) => setTimeout(resolve, 100));
    } finally {
      await worker.stop();
    }

    assert.equal(seen.length, 1);
    assert.ok(seen[0]?.error instanceof DimensionMismatchError);
    assert.equal(seen[0]?.context.stopped, true);
    assert.equal(model.batches.length, 1);
    const stats = await index.queueStats();
    assert.equal(stats.failed, 1);
    assert.equal(stats.pending, 1);
  });
});

test("startEmbeddingWorker reports a rate limit with the provider's retry delay", async () => {
  await withIndex(async (index, model) => {
    model.handler = () => {
      throw rateLimitError(30);
    };
    await index.upsertMany([{ content: "rl", tree: "docs" }]);
    const seen: { error: unknown; context: WorkerErrorContext }[] = [];
    const worker = index.startEmbeddingWorker({
      intervalMs: 10,
      onError: (error, context) => {
        seen.push({ error, context });
      },
    });
    try {
      await waitFor(() => seen.length >= 1);
    } finally {
      await worker.stop();
    }
    assert.ok(seen[0]?.error instanceof RateLimitError);
    assert.equal(seen[0]?.context.phase, "process");
    assert.equal(seen[0]?.context.consecutiveErrors, 0);
    assert.equal(seen[0]?.context.backoffMs, 30);
  });
});

test("a throwing onError does not stop the worker", async () => {
  await withIndex(async (index, model) => {
    model.handler = (values) => values.map(() => [1, 0, 0]);
    await index.upsertMany([{ content: "recover", tree: "docs" }]);
    let calls = 0;
    const worker = index.startEmbeddingWorker({
      intervalMs: 10,
      onError: () => {
        calls++;
        throw new Error("observer bug");
      },
    });
    try {
      await waitFor(() => calls >= 1);
      // Fix the model; the worker must still be alive to drain the row.
      model.handler = (values) => values.map(() => [0, 1, 0, 0]);
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        if ((await index.queueStats()).pending === 0) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    } finally {
      await worker.stop();
    }
    assert.equal((await index.queueStats()).pending, 0);
  });
});

test("pruneEmbeddingQueue removes terminal rows", async () => {
  await withIndex(async (index) => {
    await index.upsertMany([{ content: "done", tree: "docs" }]);
    await index.processEmbeddings();
    // one 'completed' terminal row now exists
    const pruned = await index.pruneEmbeddingQueue({ retentionMs: 0 });
    assert.equal(pruned, 1);
    assert.equal((await queueRows(index.schema)).length, 0);
  });
});

test("pruneEmbeddingQueue rejects a non-finite or negative retention", async () => {
  await withIndex(async (index) => {
    for (const retentionMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        () => index.pruneEmbeddingQueue({ retentionMs }),
        InvalidInputError,
        String(retentionMs),
      );
    }
  });
});

test("embedding queue routines are callable directly from SQL", async () => {
  await withIndex(async (index) => {
    const inserted = await index.upsert({
      content: "direct sql queue",
      tree: "docs",
    });
    const [pendingBefore] = await sql<{ n: string }[]>`
      select ${sql(index.schema)}.pending_embedding_count()::text as n
    `;
    assert.equal(pendingBefore?.n, "1");

    const claimed = await sql<
      {
        queue_id: string;
        record_id: string;
        content_version: number;
        content: string;
        claimed: boolean;
      }[]
    >`
      select queue_id::text, record_id, content_version, content, claimed
      from ${sql(index.schema)}.claim_embedding_batch(10, interval '5 minutes', 1)
    `;
    assert.equal(claimed.length, 1);
    const first = claimed[0];
    assert.ok(first);
    assert.equal(first.record_id, inserted.id);
    assert.equal(first.claimed, true);

    await sql`
      select ${sql(index.schema)}.fail_embedding(${first.queue_id}::bigint, 'direct sql failure')
    `;
    await sql`
      update ${sql(index.schema)}.embedding_queue set visible_at = now() where id = ${first.queue_id}::bigint
    `;
    // Next claim with max_attempts = 1 sweeps the exhausted row to 'failed'.
    await sql`select * from ${sql(index.schema)}.claim_embedding_batch(10, interval '5 minutes', 1)`;

    const failures = await sql<{ queue_id: string; last_error: string }[]>`
      select queue_id::text, last_error
      from ${sql(index.schema)}.list_embedding_failures(10, null)
    `;
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.last_error, "direct sql failure");

    const [statsFailed] = await sql<{ failed: string }[]>`
      select failed::text from ${sql(index.schema)}.embedding_queue_stats()
    `;
    assert.equal(statsFailed?.failed, "1");

    const [retried] = await sql<{ n: string }[]>`
      select ${sql(index.schema)}.retry_embedding_failures(array[${first.queue_id}::bigint])::text as n
    `;
    assert.equal(retried?.n, "1");

    const reclaimed = await sql<
      { queue_id: string; record_id: string; content_version: number }[]
    >`
      select queue_id::text, record_id, content_version
      from ${sql(index.schema)}.claim_embedding_batch(10, interval '5 minutes', 3)
    `;
    assert.equal(reclaimed.length, 1);
    await sql`
      select ${sql(index.schema)}.release_embedding(${first.queue_id}::bigint, interval '0 milliseconds')
    `;
    await sql`
      select * from ${sql(index.schema)}.claim_embedding_batch(10, interval '5 minutes', 3)
    `;
    await assert.rejects(
      () =>
        sql`
          select ${sql(index.schema)}.complete_embedding
          ( ${first.queue_id}::bigint
          , ${inserted.id}::uuid
          , ${first.content_version}
          , null::public.halfvec(4)
          )
        `,
      (err: { readonly code?: string }) => err.code === "22023",
    );
    const [completed] = await sql<{ outcome: string }[]>`
      select ${sql(index.schema)}.complete_embedding
      ( ${first.queue_id}::bigint
      , ${inserted.id}::uuid
      , ${first.content_version}
      , '[1,0,0,0]'::public.halfvec(4)
      ) as outcome
    `;
    assert.equal(completed?.outcome, "completed");

    // Fractional milliseconds in TypeScript options round-trip through interval arithmetic.
    await index.upsert({ content: "fractional lease", tree: "docs" });
    const fractionalPass = await index.processEmbeddings({
      leaseDurationMs: 1000.5,
    });
    assert.equal(fractionalPass.embedded, 1);

    const [pruned] = await sql<{ n: string }[]>`
      select ${sql(index.schema)}.prune_embedding_queue(interval '0 milliseconds')::text as n
    `;
    assert.equal(pruned?.n, "2");
  });
});
