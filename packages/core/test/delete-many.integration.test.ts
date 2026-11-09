import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { noEmbedding } from "../src/embedding.ts";
import { BatchTooLargeError, InvalidInputError } from "../src/errors.ts";
import { type Index, openIndex } from "../src/open-index.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

async function withIndex(fn: (index: Index) => Promise<void>): Promise<void> {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    await fn(await openIndex(sql, schema, { embedding: noEmbedding }));
  } finally {
    await dropTestSchema(sql, schema);
  }
}

async function recordCount(schema: string): Promise<number> {
  const [row] = await sql<{ readonly count: string }[]>`
    select count(*)::text as count from ${sql(schema)}.record
  `;
  return Number(row?.count);
}

async function queueCount(schema: string): Promise<number> {
  const [row] = await sql<{ readonly count: string }[]>`
    select count(*)::text as count from ${sql(schema)}.embedding_queue
  `;
  return Number(row?.count);
}

const MISSING_ID = "019ce89d-f8b4-7000-8000-000000000001";

test("deleteMany removes existing records and ignores missing and repeated ids", async () => {
  await withIndex(async (index) => {
    const [a, b, keep] = await index.upsertMany([
      { content: "a", tree: "docs" },
      { content: "b", tree: "docs" },
      { content: "keep", tree: "docs" },
    ]);
    assert.ok(a && b && keep);
    assert.equal(await queueCount(index.schema), 3);

    const result = await index.deleteMany([a.id, b.id, a.id, MISSING_ID]);
    assert.deepEqual(result, { count: 2 });
    assert.equal(await recordCount(index.schema), 1);
    assert.equal((await index.get(keep.id)).content, "keep");
    // Queue rows of deleted records cascade.
    assert.equal(await queueCount(index.schema), 1);

    assert.deepEqual(await index.deleteMany([a.id]), { count: 0 });
    assert.deepEqual(await index.deleteMany([]), { count: 0 });
  });
});

test("deleteMany validates the whole batch before it deletes anything", async () => {
  await withIndex(async (index) => {
    const [a] = await index.upsertMany([{ content: "a", tree: "docs" }]);
    assert.ok(a);

    await assert.rejects(
      () => index.deleteMany([a.id, "8f14e45f-ceea-4e7a-8b6c-1d2e3f4a5b6c"]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.match(
          error.message,
          /^Invalid record ids: 1: expected a UUIDv7/,
        );
        assert.deepEqual(error.issues[0]?.path, [1]);
        return true;
      },
    );
    await assert.rejects(
      () => index.deleteMany("not-an-array" as unknown as string[]),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.deleteMany(Array.from({ length: 1001 }, () => a.id)),
      (error: unknown) =>
        error instanceof BatchTooLargeError &&
        error.size === 1001 &&
        error.maximum === 1000,
    );
    assert.equal(await recordCount(index.schema), 1);
  });
});

test("deleteMany joins the caller's transaction", async () => {
  await withIndex(async (index) => {
    const [a] = await index.upsertMany([{ content: "a", tree: "docs" }]);
    assert.ok(a);
    await assert.rejects(
      sql.begin(async (tx) => {
        assert.deepEqual(await index.with(tx).deleteMany([a.id]), {
          count: 1,
        });
        throw new Error("roll back");
      }),
      /roll back/,
    );
    assert.equal(await recordCount(index.schema), 1);
  });
});

test("the documented sync recipe deletes only records whose source is gone", async () => {
  await withIndex(async (index) => {
    // 1,203 chunks under docs, and one record outside the sync scope.
    const chunks = Array.from({ length: 1203 }, (_, i) => ({
      tree: `docs.d${i % 3}`,
      name: `chunk-${i}`,
      content: `chunk ${i}`,
    }));
    for (let i = 0; i < chunks.length; i += 1000) {
      await index.upsertMany(chunks.slice(i, i + 1000));
    }
    await index.upsert({ content: "other", tree: "other", name: "keep" });

    // The source lost every fifth chunk.
    const source = chunks.filter((_, i) => i % 5 !== 0);

    // The recipe from docs/guides/ingest.md.
    const current = new Set(source.map((c) => `${c.tree}\u0000${c.name}`));
    const stale: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await index.search({
        filter: { tree: "docs" },
        order: "asc",
        limit: 1000,
        ...(cursor === undefined ? {} : { after: cursor }),
      });
      for (const record of page) {
        if (!current.has(`${record.tree}\u0000${record.name}`)) {
          stale.push(record.id);
        }
      }
      if (page.length < 1000) break;
      cursor = page.at(-1)?.id;
    }
    let deleted = 0;
    for (let i = 0; i < stale.length; i += 1000) {
      deleted += (await index.deleteMany(stale.slice(i, i + 1000))).count;
    }

    assert.equal(deleted, chunks.length - source.length);
    assert.equal(await recordCount(index.schema), source.length + 1);
    assert.equal((await index.getByName("other", "keep")).content, "other");
  });
});
