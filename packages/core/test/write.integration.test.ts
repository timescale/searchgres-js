import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex } from "../src/create-index.ts";
import { noEmbedding } from "../src/embedding.ts";
import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  InvalidInputError,
} from "../src/errors.ts";
import { openIndex } from "../src/open-index.ts";
import { expectSqlState } from "./support/assert.ts";
import { connect, dropTestSchema, randomTestSchema } from "./support/db.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

test("upsert methods preserve input order, normalize temporal values, and queue only null embeddings", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    const point = new Date("2026-01-02T03:04:05.678Z");
    const intervalStart = new Date("2026-02-03T04:05:06.789Z");
    const intervalEnd = "2026-02-04T06:05:06.789+01:00";

    const pointResult = await index.upsert({
      content: "point",
      temporal: [point],
    });
    const batch = await index.upsertMany([
      {
        content: "precomputed",
        tree: "docs.embeddings",
        name: "vector",
        embedding: [1, 0, 0, 0],
      },
      {
        content: "interval",
        tree: "docs.temporal",
        temporal: [intervalStart, intervalEnd],
      },
    ]);

    assert.equal(pointResult.status, "inserted");
    assert.deepEqual(
      batch.map((result) => result.status),
      ["inserted", "inserted"],
    );

    const record = sql`${sql(schema)}.record`;
    const rows = await sql<
      {
        readonly id: string;
        readonly content: string;
        readonly embedding: string | null;
        readonly lower: Date | null;
        readonly upper: Date | null;
        readonly lower_inc: boolean | null;
        readonly upper_inc: boolean | null;
      }[]
    >`
      select
        id
      , content
      , embedding
      , pg_catalog.lower(temporal) as lower
      , pg_catalog.upper(temporal) as upper
      , pg_catalog.lower_inc(temporal) as lower_inc
      , pg_catalog.upper_inc(temporal) as upper_inc
      from ${record}
      where id = any(${[pointResult.id, ...batch.map((result) => result.id)]}::uuid[])
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const pointRow = byId.get(pointResult.id);
    const precomputedRow = byId.get(batch[0]?.id ?? "");
    const intervalRow = byId.get(batch[1]?.id ?? "");

    assert.equal(pointRow?.content, "point");
    assert.equal(pointRow?.lower?.toISOString(), point.toISOString());
    assert.equal(pointRow?.upper?.toISOString(), point.toISOString());
    assert.equal(pointRow?.lower_inc, true);
    assert.equal(pointRow?.upper_inc, true);
    assert.equal(precomputedRow?.content, "precomputed");
    assert.equal(precomputedRow?.embedding, "[1,0,0,0]");
    assert.equal(intervalRow?.content, "interval");
    assert.equal(
      intervalRow?.lower?.toISOString(),
      intervalStart.toISOString(),
    );
    assert.equal(intervalRow?.upper?.toISOString(), "2026-02-04T05:05:06.789Z");
    assert.equal(intervalRow?.lower_inc, true);
    assert.equal(intervalRow?.upper_inc, false);

    const queue = sql`${sql(schema)}.embedding_queue`;
    const queueRows = await sql<{ readonly record_id: string }[]>`
      select record_id
      from ${queue}
      where record_id = any(${[pointResult.id, ...batch.map((result) => result.id)]}::uuid[])
      order by record_id
    `;
    assert.deepEqual(
      queueRows.map((row) => row.record_id).sort(),
      [pointResult.id, batch[1]?.id].sort(),
    );

    const namedWithId = await index.upsert({
      id: "019ce89d-f8b4-7000-8000-000000000004",
      content: "named explicit id",
      tree: "docs.ids",
      name: "named",
    });
    assert.equal(namedWithId.id, "019ce89d-f8b4-7000-8000-000000000004");
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("insert conflicts roll back the full batch and ignore reports skipped inputs", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    const existing = await index.upsert({
      content: "existing",
      tree: "docs",
      name: "same",
    });

    await assert.rejects(
      () =>
        index.upsertMany([
          { id: existing.id, content: "id alias" },
          { content: "name alias", tree: "docs", name: "same" },
        ]),
      InvalidInputError,
    );

    await assert.rejects(
      () => index.insert({ content: "conflict", tree: "docs", name: "same" }),
      ConflictError,
    );

    await assert.rejects(
      () =>
        index.insertMany([
          { content: "conflict", tree: "docs", name: "same" },
          {
            id: "019ce89d-f8b4-7000-8000-000000000001",
            content: "must roll back",
          },
        ]),
      ConflictError,
    );

    const record = sql`${sql(schema)}.record`;
    const afterRollback = await sql<{ readonly content: string }[]>`
      select content
      from ${record}
      order by content
    `;
    assert.deepEqual(Array.from(afterRollback), [{ content: "existing" }]);

    const ignored = await index.upsertMany(
      [
        { content: "ignored", tree: "docs", name: "same" },
        {
          id: "019ce89d-f8b4-7000-8000-000000000002",
          content: "accepted",
        },
      ],
      { onConflict: "ignore" },
    );
    assert.deepEqual(
      ignored.map((result) => result.status),
      ["skipped", "inserted"],
    );
    assert.equal(ignored[1]?.id, "019ce89d-f8b4-7000-8000-000000000002");
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("upsert replaces by default, preserves current embeddings, and skips unchanged rows", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    const created = await index.upsert({
      content: "first",
      tree: "docs",
      name: "entry",
      meta: { revision: 1 },
      embedding: [1, 0, 0, 0],
    });
    const record = sql`${sql(schema)}.record`;
    const queue = sql`${sql(schema)}.embedding_queue`;

    const metadataReplacement = await index.upsert({
      content: "first",
      tree: "docs",
      name: "entry",
      meta: { revision: 2 },
    });
    assert.equal(metadataReplacement.status, "updated");
    assert.equal(metadataReplacement.id, created.id);

    const [afterMetadata] = await sql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
      }[]
    >`
      select embedding, content_version, version
      from ${record}
      where id = ${created.id}
    `;
    assert.deepEqual(afterMetadata, {
      embedding: "[1,0,0,0]",
      content_version: 1,
      version: "2",
    });
    const beforeContentChangeQueue = await sql`
      select id
      from ${queue}
      where record_id = ${created.id}
    `;
    assert.equal(beforeContentChangeQueue.length, 0);

    const contentReplacement = await index.upsert(
      {
        content: "second",
        tree: "docs",
        name: "entry",
        meta: { revision: 2 },
      },
      { onConflict: "replace" },
    );
    assert.equal(contentReplacement.status, "updated");
    const [afterContent] = await sql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
      }[]
    >`
      select embedding, content_version, version
      from ${record}
      where id = ${created.id}
    `;
    assert.deepEqual(afterContent, {
      embedding: null,
      content_version: 2,
      version: "3",
    });
    const afterContentChangeQueue = await sql`
      select id
      from ${queue}
      where record_id = ${created.id}
    `;
    assert.equal(afterContentChangeQueue.length, 1);

    const unchanged = await index.upsert(
      {
        content: "second",
        tree: "docs",
        name: "entry",
        meta: { revision: 2 },
      },
      { onConflict: "replace" },
    );
    assert.equal(unchanged.status, "skipped");
    const [afterSkipped] = await sql<{ readonly version: string }[]>`
      select version
      from ${record}
      where id = ${created.id}
    `;
    assert.equal(afterSkipped?.version, "3");
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("ignore resolves a concurrently committed named conflict", async () => {
  const schema = randomTestSchema();
  const writer = connect();
  let releaseWriter: (() => void) | undefined;
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    let writerInserted!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    const inserted = new Promise<void>((resolve) => {
      writerInserted = resolve;
    });
    let existingId = "";
    const writerTransaction = writer.begin(async (tx) => {
      const [row] = await tx<{ readonly id: string }[]>`
        insert into ${tx(schema)}.record (content, tree, name)
        values ('concurrent', 'docs', 'same')
        returning id
      `;
      existingId = row?.id ?? "";
      writerInserted();
      await release;
    });

    await inserted;
    const ignored = index.upsertMany(
      [
        { content: "conflict", tree: "docs", name: "same" },
        {
          id: "019ce89d-f8b4-7000-8000-000000000007",
          content: "nonconflicting",
        },
      ],
      { onConflict: "ignore" },
    );
    await waitForBlockedTransaction(sql);
    releaseWriter?.();
    await writerTransaction;
    const results = await ignored;

    assert.ok(existingId);
    assert.deepEqual(
      results.map((result) => result.status),
      ["skipped", "inserted"],
    );
    assert.equal(results[0]?.id, existingId);
    assert.equal(results[1]?.id, "019ce89d-f8b4-7000-8000-000000000007");
  } finally {
    releaseWriter?.();
    await writer.end();
    await dropTestSchema(sql, schema);
  }
});

test("upsert and patch reject empty content and empty names", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });

    await assert.rejects(
      () => index.upsert({ content: "" }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        // upsert delegates to upsertMany, so the position is always reported.
        assert.deepEqual(error.issues[0]?.path, [0, "content"]);
        assert.match(error.message, /content must not be empty/);
        return true;
      },
    );
    // In a batch the offending position is reported and nothing is written.
    await assert.rejects(
      () =>
        index.upsertMany([
          { content: "fine", tree: "docs" },
          { content: "", tree: "docs" },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, [1, "content"]);
        return true;
      },
    );
    const stats = await index.queueStats();
    assert.equal(stats.pending, 0, "nothing was enqueued");

    const created = await index.upsert({ content: "kept" });
    const head = await index.get(created.id);
    await assert.rejects(
      () => index.patch(created.id, head.versionHash, { content: "" }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, ["content"]);
        return true;
      },
    );
    assert.equal((await index.get(created.id)).content, "kept");

    // An empty-string name is almost always a caller bug; null is the explicit
    // "unnamed" spelling and keeps working.
    await assert.rejects(
      () => index.upsert({ content: "named", tree: "docs", name: "" }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, [0, "name"]);
        assert.match(error.message, /use null for an unnamed record/);
        return true;
      },
    );
    const named = await index.upsert({
      content: "named",
      tree: "docs",
      name: "n",
    });
    const namedHead = await index.get(named.id);
    await assert.rejects(
      () => index.patch(named.id, namedHead.versionHash, { name: "" }),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, ["name"]);
        return true;
      },
    );
    const unnamed = await index.patch(named.id, namedHead.versionHash, {
      name: null,
    });
    assert.equal(unnamed.name, null);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("upsert validates temporal values, caps batches, and rejects wrong vector dimensions", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });

    await assert.rejects(
      () =>
        index.upsert({
          content: "invalid interval",
          temporal: ["2026-01-02T00:00:00Z", "2026-01-01T00:00:00Z"],
        }),
      InvalidInputError,
    );
    await assert.rejects(
      () =>
        index.upsert({
          id: "00000000-0000-4000-8000-000000000005",
          content: "uuid v4 is rejected",
        }),
      InvalidInputError,
    );
    await assert.rejects(
      () =>
        index.upsertMany([
          {
            id: "019ce89d-f8b4-7000-8000-000000000006",
            content: "named id one",
            tree: "docs",
            name: "one",
          },
          {
            id: "019ce89d-f8b4-7000-8000-000000000006",
            content: "named id two",
            tree: "docs",
            name: "two",
          },
        ]),
      InvalidInputError,
    );
    const record = sql`${sql(schema)}.record`;
    await expectSqlState(
      () =>
        sql`
          insert into ${record} (id, content)
          values ('00000000-0000-4000-8000-000000000005', 'direct uuid v4')
        `,
      "23514",
    );
    await assert.rejects(
      () =>
        index.upsertMany([
          { content: "named duplicate one", tree: "docs", name: "duplicate" },
          { content: "named duplicate two", tree: "docs", name: "duplicate" },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, [1]);
        return true;
      },
    );
    await assert.rejects(
      () =>
        index.upsert({
          content: "missing timezone",
          temporal: ["2026-01-01T00:00:00"],
        }),
      InvalidInputError,
    );
    await assert.rejects(
      () => index.upsert({ content: "wrong vector", embedding: [1, 0, 0] }),
      (error: unknown) => {
        assert.ok(error instanceof DimensionMismatchError);
        assert.equal(error.expected, 4);
        assert.equal(error.actual, 3);
        assert.equal(error.position, 0);
        return true;
      },
    );
    await assert.rejects(
      () =>
        index.upsertMany([
          { content: "right vector", embedding: [1, 0, 0, 0] },
          { content: "wrong vector", embedding: [1, 0] },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof DimensionMismatchError);
        assert.equal(error.actual, 2);
        assert.equal(error.position, 1);
        assert.match(error.message, /at record 1/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        index.upsertMany([
          {
            id: "019ce89d-f8b4-7000-8000-000000000003",
            content: "duplicate one",
          },
          {
            id: "019ce89d-f8b4-7000-8000-000000000003",
            content: "duplicate two",
          },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, [1]);
        return true;
      },
    );
    // PostgreSQL `uuid` equality ignores case, so the fast-path must too.
    await assert.rejects(
      () =>
        index.upsertMany([
          {
            id: "019ce89d-f8b4-7000-8000-000000000008",
            content: "mixed case one",
          },
          {
            id: "019CE89D-F8B4-7000-8000-000000000008",
            content: "mixed case two",
          },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof InvalidInputError);
        assert.deepEqual(error.issues[0]?.path, [1]);
        assert.match(error.message, /duplicate explicit id/);
        return true;
      },
    );
    await assert.rejects(
      () =>
        index.upsertMany(
          Array.from({ length: 1001 }, () => ({ content: "too many" })),
        ),
      (error: unknown) => {
        assert.ok(error instanceof BatchTooLargeError);
        assert.equal(error.size, 1001);
        assert.equal(error.maximum, 1000);
        return true;
      },
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("batch_upsert is callable directly as SQL", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const fn = sql`${sql(schema)}.batch_upsert`;

    const inserted = await sql<
      { readonly ord: string; readonly id: string; readonly status: string }[]
    >`
      select ord, id, status
      from ${fn}
      ( array[null]::uuid[]
      , array['direct']::text[]
      , '[{}]'::jsonb
      , array['docs']::ltree[]
      , array[null]::tstzrange[]
      , array['leaf']::text[]
      , array[null]::halfvec[]
      , 'error'
      )
    `;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0]?.status, "inserted");
    const id = inserted[0]?.id;
    assert.ok(id);

    const replaced = await sql<
      { readonly id: string; readonly status: string }[]
    >`
      select ord, id, status
      from ${fn}
      ( array[null]::uuid[]
      , array['direct v2']::text[]
      , '[{}]'::jsonb
      , array['docs']::ltree[]
      , array[null]::tstzrange[]
      , array['leaf']::text[]
      , array[null]::halfvec[]
      , 'replace'
      )
    `;
    assert.equal(replaced[0]?.id, id);
    assert.equal(replaced[0]?.status, "updated");

    await expectSqlState(
      () => sql`
        select ord, id, status
        from ${fn}
        ( array[null]::uuid[]
        , array['direct v3']::text[]
        , '[{}]'::jsonb
        , array['docs']::ltree[]
        , array[null]::tstzrange[]
        , array['leaf']::text[]
        , array[null]::halfvec[]
        , 'error'
        )
      `,
      "23505",
    );

    await expectSqlState(
      () => sql`
        select ord, id, status
        from ${fn}
        ( array[null]::uuid[]
        , array['a', 'b']::text[]
        , '[{}]'::jsonb
        , array['docs']::ltree[]
        , array[null]::tstzrange[]
        , array[null]::text[]
        , array[null]::halfvec[]
        , 'error'
        )
      `,
      "22023",
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

async function waitForBlockedTransaction(sql: Sql): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const [row] = await sql<{ readonly waiting: boolean }[]>`
      select exists (
        select 1
        from pg_catalog.pg_locks
        where not granted
          and locktype = 'transactionid'
      ) as waiting
    `;
    if (row?.waiting) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the concurrent upsert to block");
}
