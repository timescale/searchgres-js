import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import type { WorkerErrorContext } from "../src/embedding-worker.ts";
import { InvalidConfigError } from "../src/errors.ts";
import {
  type Index,
  type OpenIndexOptions,
  openIndex,
} from "../src/open-index.ts";
import { truncateCharacters } from "../src/truncate.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";
import {
  type ControllableEmbeddingModel,
  controllableEmbeddingModel,
} from "./support/embedding.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(
  options: Omit<OpenIndexOptions, "embedding">,
  fn: (index: Index, model: ControllableEmbeddingModel) => Promise<void>,
): Promise<void> {
  const schema = randomTestSchema();
  const model = controllableEmbeddingModel();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, {
      embedding: model,
      ...options,
    });
    await fn(index, model);
  } finally {
    await dropTestSchema(sql, schema);
  }
}

async function pendingAttempts(schema: string): Promise<readonly number[]> {
  const rows = await sql<{ readonly attempts: number }[]>`
    select attempts from ${sql(schema)}.embedding_queue order by id
  `;
  return rows.map((row) => row.attempts);
}

test("document and query prefixes reach only their own embedding inputs", async () => {
  await withIndex(
    { documentPrefix: "search_document: ", queryPrefix: "search_query: " },
    async (index, model) => {
      assert.equal(index.documentPrefix, "search_document: ");
      assert.equal(index.queryPrefix, "search_query: ");
      const [first] = await index.upsertMany([
        { content: "alpha widget", tree: "docs" },
        { content: "beta widget", tree: "docs" },
        { content: "gamma widget", tree: "docs" },
      ]);
      assert.ok(first);

      // One batch of two (embedMany) and one batch of one (embed).
      await index.processEmbeddings({ batchSize: 2 });
      assert.deepEqual(model.batches, [
        ["search_document: alpha widget", "search_document: beta widget"],
        ["search_document: gamma widget"],
      ]);

      model.batches.length = 0;
      await index.search({ semantic: "which widget" });
      await index.search({ semantic: "hybrid widget", fulltext: "widget" });
      assert.deepEqual(model.batches, [
        ["search_query: which widget"],
        ["search_query: hybrid widget"],
      ]);

      // Stored content and full-text search do not see the prefix.
      assert.equal((await index.get(first.id)).content, "alpha widget");
      assert.equal(
        (await index.search({ fulltext: "search_document" })).length,
        0,
      );
      assert.equal((await index.search({ fulltext: "alpha" })).length, 1);

      // A supplied vector is stored as given and needs no provider call.
      model.batches.length = 0;
      await index.upsert({
        content: "delta widget",
        tree: "docs",
        embedding: [0, 0, 1, 0],
      });
      await index.processEmbeddings();
      assert.deepEqual(model.batches, []);
    },
  );
});

test("after a documentPrefix change, clearing vectors re-embeds with the new prefix", async () => {
  await withIndex({ documentPrefix: "old: " }, async (index, model) => {
    await index.upsertMany([{ content: "body", tree: "docs" }]);
    await index.processEmbeddings();
    const changed = await openIndex(sql, index.schema, {
      embedding: model,
      documentPrefix: "new: ",
    });
    await sql`update ${sql(index.schema)}.record set embedding = null`;
    await changed.processEmbeddings();
    assert.deepEqual(model.batches, [["old: body"], ["new: body"]]);
  });
});

test("empty default prefixes leave embedding inputs unchanged", async () => {
  await withIndex({}, async (index, model) => {
    assert.equal(index.documentPrefix, "");
    assert.equal(index.queryPrefix, "");
    await index.upsertMany([{ content: "plain content", tree: "docs" }]);
    await index.processEmbeddings();
    await index.search({ semantic: "plain query" });
    assert.deepEqual(model.batches, [["plain content"], ["plain query"]]);
  });
});

test("a prefix counts toward the truncation budget", async () => {
  await withIndex(
    {
      documentPrefix: "doc: ",
      queryPrefix: "q: ",
      truncate: truncateCharacters(12),
    },
    async (index, model) => {
      await index.upsertMany([{ content: "abcdefghijklmnop", tree: "docs" }]);
      await index.processEmbeddings();
      await index.search({ semantic: "qrstuvwxyz" });
      assert.deepEqual(model.batches, [["doc: abcdefg"], ["q: qrstuvwxy"]]);
    },
  );
});

test("a document prefix longer than the budget fails before any claim", async () => {
  await withIndex(
    { documentPrefix: "search_document: ", truncate: truncateCharacters(8) },
    async (index, model) => {
      await index.upsertMany([{ content: "content", tree: "docs" }]);

      await assert.rejects(
        () => index.processEmbeddings(),
        (error: unknown) =>
          error instanceof InvalidConfigError &&
          /documentPrefix does not fit the truncation budget/.test(
            error.message,
          ),
      );
      assert.deepEqual(model.batches, []);
      assert.deepEqual(await pendingAttempts(index.schema), [0]);

      const seen: { error: unknown; context: WorkerErrorContext }[] = [];
      const worker = index.startEmbeddingWorker({
        intervalMs: 10,
        onError: (error, context) => {
          seen.push({ error, context });
        },
      });
      try {
        const deadline = Date.now() + 5_000;
        while (seen.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        await worker.stop();
      }
      assert.equal(seen.length, 1);
      assert.ok(seen[0]?.error instanceof InvalidConfigError);
      assert.equal(seen[0]?.context.stopped, true);
      assert.deepEqual(model.batches, []);
      assert.deepEqual(await pendingAttempts(index.schema), [0]);

      // The query prefix is empty, so search still embeds queries.
      await index.search({ semantic: "query" });
      assert.deepEqual(model.batches, [["query"]]);
    },
  );
});

test("a query prefix longer than the budget fails semantic search only", async () => {
  await withIndex(
    { queryPrefix: "search_query: ", truncate: truncateCharacters(8) },
    async (index, model) => {
      await index.upsertMany([{ content: "content", tree: "docs" }]);
      await assert.rejects(
        () => index.search({ semantic: "query" }),
        /queryPrefix does not fit the truncation budget/,
      );
      assert.deepEqual(model.batches, []);
      assert.equal((await index.search({ fulltext: "content" })).length, 1);
      await index.processEmbeddings();
      assert.deepEqual(model.batches, [["content"]]);
    },
  );
});

test("openIndex rejects a non-string prefix", async () => {
  await assert.rejects(
    () =>
      openIndex(sql, randomTestSchema(), {
        embedding: controllableEmbeddingModel(),
        documentPrefix: 1,
      } as unknown as OpenIndexOptions),
    (error: unknown) =>
      error instanceof InvalidConfigError &&
      /^Invalid openIndex options: documentPrefix:/.test(error.message),
  );
});
