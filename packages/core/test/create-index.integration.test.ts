import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import {
  type CreateIndexOptions,
  createIndex,
  SCHEMA_FORMAT_VERSION,
} from "../src/create-index.ts";
import { ensureExtensions } from "../src/db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "../src/db/lock.ts";
import { INDEX_SCHEMA_COMMENT } from "../src/db/marker.ts";
import { noEmbedding } from "../src/embedding.ts";
import {
  ConflictError,
  InvalidConfigError,
  InvalidIndexError,
  LockTimeoutError,
  SchemaVersionError,
} from "../src/errors.ts";
import { type OpenIndexOptions, openIndex } from "../src/open-index.ts";
import { noTruncation } from "../src/truncate.ts";
import { expectSqlState } from "./support/assert.ts";
import {
  columnType,
  connect,
  connectToDatabase,
  dropTestSchema,
  indexOpclass,
  indexReloptions,
  listFunctions,
  listIndexes,
  listTriggers,
  randomTestSchema,
  schemaExists,
} from "./support/db.ts";

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await sql.end();
});

test("creates an immutable index schema and singleton format marker", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });

    assert.equal(await schemaExists(sql, schema), true);
    const [comment] = await sql<{ readonly comment: string | null }[]>`
      select pg_catalog.obj_description(oid, 'pg_namespace') as comment
      from pg_catalog.pg_namespace
      where nspname = ${schema}
    `;
    assert.equal(comment?.comment, INDEX_SCHEMA_COMMENT);
    const version = sql`${sql(schema)}.version`;
    const versions = await sql<
      { readonly version: string; readonly at: Date }[]
    >`
      select version, at
      from ${version}
    `;
    assert.equal(versions.length, 1);
    assert.equal(versions[0]?.version, SCHEMA_FORMAT_VERSION);
    assert.ok(versions[0]?.at instanceof Date);
    assert.equal(await columnType(sql, schema, "version", "version"), "bigint");
    await expectSqlState(
      () => sql`insert into ${version} (version) values (99)`,
      "23505",
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects an existing schema without mutating it", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    await assert.rejects(
      () => createIndex(sql, schema, { dimensions: 4 }),
      ConflictError,
    );
    assert.equal(await schemaExists(sql, schema), true);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("opens an immutable index with catalog-derived vector shape", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const index = await openIndex(sql, schema, { embedding: "mock-embedding" });

    assert.equal(index.schema, schema);
    assert.equal(index.vectorType, "halfvec");
    assert.equal(index.dimensions, 4);
    assert.equal(index.embedding, "mock-embedding");
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("openIndex validates its options before touching the database", async () => {
  // The schema does not exist: an InvalidConfigError (not InvalidIndexError)
  // proves the options were rejected before the first round-trip.
  const missing = randomTestSchema();
  const invalid: readonly [label: string, options: unknown][] = [
    ["undefined", undefined],
    ["empty object", {}],
    ["null embedding", { embedding: null }],
    ["empty model id", { embedding: "" }],
    ["object without doEmbed", { embedding: { modelId: "x" } }],
    ["non-function truncate", { embedding: "m", truncate: "24000" }],
    ["unknown key", { embedding: "m", truncator: noTruncation }],
  ];
  for (const [label, options] of invalid) {
    await assert.rejects(
      () => openIndex(sql, missing, options as OpenIndexOptions),
      (error: unknown) => {
        assert.ok(error instanceof InvalidConfigError, label);
        assert.ok(error.issues.length > 0, label);
        assert.match(error.message, /^Invalid openIndex options: /, label);
        return true;
      },
      label,
    );
  }

  // postgres.js 4 removed sql.array(); reject such an instance before the
  // first round-trip.
  const postgresV4 = Object.assign(
    (...args: unknown[]) =>
      (sql as unknown as (...a: unknown[]) => unknown)(...args),
    {
      ...sql,
      array: () => {
        throw Object.assign(new Error("sql.array() is removed in v4"), {
          code: "ARRAY_REMOVED",
        });
      },
    },
  ) as unknown as typeof sql;
  await assert.rejects(
    () => openIndex(postgresV4, missing, { embedding: noEmbedding }),
    (error: unknown) => {
      assert.ok(error instanceof InvalidConfigError);
      assert.match(error.message, /postgres\.js 3\.x/);
      return true;
    },
  );

  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const byId = await openIndex(sql, schema, { embedding: "mock-embedding" });
    assert.equal(byId.embedding, "mock-embedding");
    const withoutModel = await openIndex(sql, schema, {
      embedding: noEmbedding,
      truncate: noTruncation,
    });
    // Validation must hand back the same object so the identity guard works.
    assert.equal(withoutModel.embedding, noEmbedding);
    assert.equal(withoutModel.truncate, noTruncation);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("createIndex validates its options and honors the lock budget", async () => {
  const schema = randomTestSchema();
  const invalid: readonly [label: string, options: unknown][] = [
    ["negative lock timeout", { lockTimeoutMs: -1 }],
    ["fractional transaction timeout", { transactionTimeoutMs: 1.5 }],
    ["string timeout", { lockTimeoutMs: "30s" }],
    ["unknown key", { statementTimeoutMs: 1000 }],
  ];
  for (const [label, options] of invalid) {
    await assert.rejects(
      () =>
        createIndex(
          sql,
          schema,
          { dimensions: 4 },
          options as CreateIndexOptions,
        ),
      (error: unknown) => {
        assert.ok(error instanceof InvalidConfigError, label);
        assert.ok(error.issues.length > 0, label);
        assert.match(error.message, /^Invalid createIndex options: /, label);
        return true;
      },
      label,
    );
  }
  assert.equal(await schemaExists(sql, schema), false);

  // Hold the per-schema lock from another transaction: createIndex for the
  // same schema must time out and leave nothing behind, while a different
  // schema can be created concurrently without waiting.
  const otherSchema = randomTestSchema();
  let locked!: () => void;
  let release!: () => void;
  const lockHeld = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const releaseHolder = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = sql.begin(async (tx) => {
    await acquireAdvisoryLock(tx, advisoryLockKey(schema));
    locked();
    await releaseHolder;
  });
  await lockHeld;
  try {
    await assert.rejects(
      () => createIndex(sql, schema, { dimensions: 4 }, { lockTimeoutMs: 50 }),
      LockTimeoutError,
    );
    assert.equal(await schemaExists(sql, schema), false);
    await createIndex(
      sql,
      otherSchema,
      { dimensions: 4 },
      { lockTimeoutMs: 50 },
    );
    assert.equal(await schemaExists(sql, otherSchema), true);
  } finally {
    release();
    await holder;
    await dropTestSchema(sql, otherSchema);
  }

  // With the lock free, an explicit budget provisions normally.
  try {
    await createIndex(
      sql,
      schema,
      { dimensions: 4 },
      { lockTimeoutMs: 5_000, transactionTimeoutMs: 60_000 },
    );
    assert.equal(await schemaExists(sql, schema), true);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rejects plain schemas and unsupported schema formats", async () => {
  const plainSchema = randomTestSchema();
  const versionedSchema = randomTestSchema();
  try {
    await assert.rejects(
      () => openIndex(sql, plainSchema, { embedding: "mock-embedding" }),
      /is not a searchgres index: the schema does not exist$/,
    );
    await sql`create schema ${sql(plainSchema)}`;
    await assert.rejects(
      () => openIndex(sql, plainSchema, { embedding: "mock-embedding" }),
      InvalidIndexError,
    );

    await createIndex(sql, versionedSchema, { dimensions: 4 });
    await sql`drop index ${sql(versionedSchema)}.record_embedding_hnsw_idx`;
    await assert.rejects(
      () => openIndex(sql, versionedSchema, { embedding: "mock-embedding" }),
      /: the vector index \(record_embedding_hnsw_idx or record_embedding_prism_idx\) does not exist$/,
    );
    await sql`
      create index record_embedding_hnsw_idx
      on ${sql(versionedSchema)}.record
      using hnsw (embedding public.halfvec_cosine_ops)
    `;
    await sql`
      update ${sql(versionedSchema)}.version
      set version = '1'
    `;
    await assert.rejects(
      () => openIndex(sql, versionedSchema, { embedding: "mock-embedding" }),
      SchemaVersionError,
    );
  } finally {
    await dropTestSchema(sql, plainSchema);
    await dropTestSchema(sql, versionedSchema);
  }
});

test("creates the configured schema shape and search indexes", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, {
      dimensions: 4,
      bm25: { k1: 1.5, b: 0.5 },
      vectorIndex: { method: "hnsw", m: 8, efConstruction: 32 },
    });

    assert.equal(
      await columnType(sql, schema, "record", "embedding"),
      "halfvec(4)",
    );
    assert.equal(await columnType(sql, schema, "record", "tree"), "ltree");
    assert.equal(
      await columnType(sql, schema, "embedding_queue", "record_id"),
      "uuid",
    );
    assert.deepEqual(await listTriggers(sql, schema, "record"), [
      "record_enqueue_after_embedding_input",
      "record_enqueue_after_insert",
      "record_integrity_before_write",
    ]);
    assert.ok(
      (await listFunctions(sql, schema)).includes("batch_upsert"),
      "missing batch_upsert routine",
    );

    const indexes = await listIndexes(sql, schema, "record");
    for (const index of [
      "record_meta_gin_idx",
      "record_temporal_gist_idx",
      "record_content_bm25_idx",
      "record_embedding_hnsw_idx",
      "record_tree_gist_idx",
      "record_tree_name_uidx",
    ]) {
      assert.ok(indexes.includes(index), `missing index ${index}`);
    }
    assert.equal(
      await indexOpclass(sql, schema, "record_embedding_hnsw_idx"),
      "halfvec_cosine_ops",
    );
    assert.deepEqual(
      await indexReloptions(sql, schema, "record_embedding_hnsw_idx"),
      ["m=8", "ef_construction=32"],
    );
    assert.deepEqual(
      await indexReloptions(sql, schema, "record_content_bm25_idx"),
      ["text_config=english", "k1=1.5", "b=0.5"],
    );
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("direct SQL supports precomputed and asynchronous embeddings", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const embeddingType = sql`public.${sql("halfvec")}`;
    const record = sql`${sql(schema)}.record`;
    const queue = sql`${sql(schema)}.embedding_queue`;

    const [precomputed] = await sql<
      {
        readonly id: string;
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      insert into ${record}
        (content, embedding, content_version, version)
      values
        ('precomputed v1', ${"[1,0,0,0]"}::${embeddingType}, 99, 99)
      returning id, embedding, content_version, version, version_hash
    `;
    assert.ok(precomputed);
    assert.equal(precomputed.embedding, "[1,0,0,0]");
    assert.equal(precomputed.content_version, 1);
    assert.equal(precomputed.version, "1");
    assert.match(precomputed.version_hash, /^[a-f0-9]{32}$/);

    const [precomputedUpdated] = await sql<
      {
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set content = 'precomputed v2',
          embedding = ${"[0,1,0,0]"}::${embeddingType},
          content_version = 999,
          version = 999
      where id = ${precomputed.id}
      returning embedding, content_version, version, version_hash
    `;
    assert.ok(precomputedUpdated);
    assert.equal(precomputedUpdated.embedding, "[0,1,0,0]");
    assert.equal(precomputedUpdated.content_version, 2);
    assert.equal(precomputedUpdated.version, "2");
    assert.notEqual(precomputedUpdated.version_hash, precomputed.version_hash);

    const precomputedQueue = await sql`
      select id
      from ${queue}
      where record_id = ${precomputed.id}
    `;
    assert.deepEqual(Array.from(precomputedQueue), []);

    const [asynchronous] = await sql<
      {
        readonly id: string;
        readonly embedding: string | null;
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      insert into ${record} (content)
      values ('async v1')
      returning id, embedding, content_version, version, version_hash
    `;
    assert.ok(asynchronous);
    assert.equal(asynchronous.embedding, null);
    assert.equal(asynchronous.content_version, 1);
    assert.equal(asynchronous.version, "1");

    const [metadataUpdated] = await sql<
      {
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set content = 'async v2'
      where id = ${asynchronous.id}
      returning content_version, version, version_hash
    `;
    assert.ok(metadataUpdated);
    assert.equal(metadataUpdated.content_version, 2);
    assert.equal(metadataUpdated.version, "2");
    assert.notEqual(metadataUpdated.version_hash, asynchronous.version_hash);

    const [metaOnlyUpdated] = await sql<
      {
        readonly content_version: number;
        readonly version: string;
        readonly version_hash: string;
      }[]
    >`
      update ${record}
      set meta = ${sql.json({ source: "direct" })}
      where id = ${asynchronous.id}
      returning content_version, version, version_hash
    `;
    assert.ok(metaOnlyUpdated);
    assert.equal(metaOnlyUpdated.content_version, 2);
    assert.equal(metaOnlyUpdated.version, "3");
    assert.notEqual(metaOnlyUpdated.version_hash, metadataUpdated.version_hash);

    const queueRows = await sql<
      {
        readonly content_version: number;
        readonly outcome: string | null;
      }[]
    >`
      select content_version, outcome
      from ${queue}
      where record_id = ${asynchronous.id}
      order by content_version
    `;
    assert.deepEqual(Array.from(queueRows), [
      { content_version: 1, outcome: null },
      { content_version: 2, outcome: null },
    ]);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("rolls back provisioning when BM25 text configuration is invalid", async () => {
  const schema = randomTestSchema();
  try {
    await assert.rejects(
      () =>
        createIndex(sql, schema, {
          dimensions: 4,
          bm25: { textConfig: "searchgres_unknown_text_config" },
        }),
      InvalidConfigError,
    );
    assert.equal(await schemaExists(sql, schema), false);
  } finally {
    await dropTestSchema(sql, schema);
  }
});

test("creates, opens, inspects, and reindexes prism and hnsw vector indexes", async () => {
  const hnswSchema = randomTestSchema();
  const prismHalfvecSchema = randomTestSchema();
  const prismVectorSchema = randomTestSchema();
  try {
    await ensureExtensions(sql, { vectorIndex: "prism" });

    await createIndex(sql, hnswSchema, { dimensions: 4 });
    const hnswIndex = await openIndex(sql, hnswSchema, {
      embedding: noEmbedding,
    });
    assert.equal(hnswIndex.vectorIndex, "hnsw");
    const hnswStats = await hnswIndex.vectorIndexStats();
    assert.equal(hnswStats.method, "hnsw");
    assert.equal(hnswStats.indexName, "record_embedding_hnsw_idx");
    assert.equal(hnswStats.embeddedRecords, 0);
    assert.equal(hnswStats.prism, null);

    await createIndex(sql, prismHalfvecSchema, {
      dimensions: 4,
      vectorType: "halfvec",
      vectorIndex: { method: "prism" },
    });
    assert.equal(
      await indexOpclass(sql, prismHalfvecSchema, "record_embedding_prism_idx"),
      "vec16_cosine_ops",
    );
    assert.deepEqual(
      await indexReloptions(
        sql,
        prismHalfvecSchema,
        "record_embedding_prism_idx",
      ),
      [],
    );

    const prismIndex = await openIndex(sql, prismHalfvecSchema, {
      embedding: noEmbedding,
    });
    assert.equal(prismIndex.vectorIndex, "prism");

    // Empty prism index starts at nlist = 1, idealNlist = 1, needsReindex = false.
    const emptyStats = await prismIndex.vectorIndexStats();
    assert.equal(emptyStats.method, "prism");
    assert.equal(emptyStats.indexName, "record_embedding_prism_idx");
    assert.equal(emptyStats.embeddedRecords, 0);
    assert.equal(emptyStats.prism?.nlist, 1);
    assert.equal(emptyStats.prism?.pinnedNlist, null);
    assert.equal(emptyStats.prism?.idealNlist, 1);
    assert.equal(emptyStats.prism?.needsReindex, false);
    assert.equal(emptyStats.prism?.reindexReason, null);

    // Insert 4 embedded records (floor(sqrt(4)) = 2 >= 2 while nlist = 1) -> bootstrap_single_cluster.
    await prismIndex.upsertMany([
      { content: "one", tree: "docs", embedding: [1, 0, 0, 0] },
      { content: "two", tree: "docs", embedding: [0, 1, 0, 0] },
      { content: "three", tree: "docs", embedding: [0, 0, 1, 0] },
      { content: "four", tree: "docs", embedding: [0, 0, 0, 1] },
    ]);
    const postIngestStats = await prismIndex.vectorIndexStats();
    assert.equal(postIngestStats.embeddedRecords, 4);
    assert.equal(postIngestStats.prism?.nlist, 1);
    assert.equal(postIngestStats.prism?.pinnedNlist, null);
    assert.equal(postIngestStats.prism?.idealNlist, 2);
    assert.equal(postIngestStats.prism?.needsReindex, true);
    assert.equal(
      postIngestStats.prism?.reindexReason,
      "bootstrap_single_cluster",
    );

    const reindexedStats = await prismIndex.reindexVectorIndex();
    assert.equal(reindexedStats.embeddedRecords, 4);
    assert.equal(reindexedStats.prism?.nlist, 2);
    assert.equal(reindexedStats.prism?.pinnedNlist, null);
    assert.equal(reindexedStats.prism?.needsReindex, false);
    assert.equal(reindexedStats.prism?.reindexReason, null);

    // Pin nlist to 1: pinnedNlist (1) != idealNlist (2), and needsReindex is false
    // because a plain REINDEX cannot grow past the pinned nlist=1.
    const pinnedOneStats = await prismIndex.reindexVectorIndex({ nlist: 1 });
    assert.equal(pinnedOneStats.prism?.nlist, 1);
    assert.equal(pinnedOneStats.prism?.pinnedNlist, 1);
    assert.equal(pinnedOneStats.prism?.idealNlist, 2);
    assert.equal(pinnedOneStats.prism?.needsReindex, false);
    assert.equal(pinnedOneStats.prism?.reindexReason, null);

    // Reset nlist back to "auto" and rebuild concurrently while verifying session timeouts are preserved.
    const singlePool = connectToDatabase(sql.options.database, 1);
    try {
      await singlePool`select pg_catalog.set_config('lock_timeout', '4321ms', false)`;
      await singlePool`select pg_catalog.set_config('statement_timeout', '8765ms', false)`;
      const singlePrism = await openIndex(singlePool, prismHalfvecSchema, {
        embedding: noEmbedding,
      });
      const concurrentStats = await singlePrism.reindexVectorIndex({
        concurrently: true,
        nlist: "auto",
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      });
      assert.equal(concurrentStats.prism?.nlist, 2);
      assert.equal(concurrentStats.prism?.pinnedNlist, null);
      assert.equal(concurrentStats.prism?.idealNlist, 2);
      assert.equal(concurrentStats.prism?.needsReindex, false);

      const [afterTimeouts] = await singlePool<
        { readonly lock_timeout: string; readonly statement_timeout: string }[]
      >`
        select
          pg_catalog.current_setting('lock_timeout') as lock_timeout
        , pg_catalog.current_setting('statement_timeout') as statement_timeout
      `;
      assert.equal(afterTimeouts?.lock_timeout, "4321ms");
      assert.equal(afterTimeouts?.statement_timeout, "8765ms");
    } finally {
      await singlePool.end();
    }

    // Custom prism reloptions on vector(4).
    await createIndex(sql, prismVectorSchema, {
      dimensions: 4,
      vectorType: "vector",
      vectorIndex: { method: "prism", nlist: 4, targetPages: 2 },
    });
    assert.equal(
      await indexOpclass(sql, prismVectorSchema, "record_embedding_prism_idx"),
      "vec32_cosine_ops",
    );
    assert.deepEqual(
      await indexReloptions(
        sql,
        prismVectorSchema,
        "record_embedding_prism_idx",
      ),
      ["nlist=4", "target_pages=2"],
    );
  } finally {
    await dropTestSchema(sql, hnswSchema);
    await dropTestSchema(sql, prismHalfvecSchema);
    await dropTestSchema(sql, prismVectorSchema);
  }
});

test("prism cluster_drift is reported after growth, cleared by reindex, and suppressed when nlist is pinned", async () => {
  const schema = randomTestSchema();
  try {
    await ensureExtensions(sql, { vectorIndex: "prism" });
    // targetPages = 1 keeps targetEntries small, so drift needs few rows.
    await createIndex(sql, schema, {
      dimensions: 4,
      vectorType: "halfvec",
      vectorIndex: { method: "prism", targetPages: 1 },
    });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    const insertEmbedded = async (count: number, offset: number) => {
      await sql`
        insert into ${sql(schema)}.record (content, embedding)
        select
          'row ' || i
        , pg_catalog.format
          ( '[%s,%s,%s,%s]'
          , pg_catalog.sin(i), pg_catalog.cos(i)
          , pg_catalog.sin(2 * i), pg_catalog.cos(2 * i)
          )::public.halfvec(4)
        from pg_catalog.generate_series(${offset + 1}::integer, ${offset + count}::integer) i
      `;
    };

    // Four rows partition into two clusters (floor(sqrt(4)) = 2).
    await insertEmbedded(4, 0);
    const twoClusters = await index.reindexVectorIndex();
    assert.equal(twoClusters.prism?.nlist, 2);
    assert.equal(twoClusters.prism?.needsReindex, false);
    const targetEntries = twoClusters.prism?.targetEntries ?? 0;
    assert.ok(targetEntries > 0);

    // Grow past the split trigger: nlist * targetEntries * 2.
    const threshold = 2 * targetEntries * 2;
    await insertEmbedded(threshold, 4);
    const drifted = await index.vectorIndexStats();
    assert.equal(drifted.embeddedRecords, threshold + 4);
    assert.equal(drifted.prism?.nlist, 2);
    assert.equal(drifted.prism?.pinnedNlist, null);
    assert.ok((drifted.prism?.idealNlist ?? 0) > 2);
    assert.equal(drifted.prism?.needsReindex, true);
    assert.equal(drifted.prism?.reindexReason, "cluster_drift");

    // An automatic rebuild re-partitions for the current row count.
    const rebuilt = await index.reindexVectorIndex();
    assert.ok((rebuilt.prism?.nlist ?? 0) > 2);
    assert.equal(rebuilt.prism?.needsReindex, false);
    assert.equal(rebuilt.prism?.reindexReason, null);

    // A pin at the old width cannot grow, so the warning stays off while
    // idealNlist still reports the better value.
    const pinned = await index.reindexVectorIndex({ nlist: 2 });
    assert.equal(pinned.prism?.nlist, 2);
    assert.equal(pinned.prism?.pinnedNlist, 2);
    assert.ok((pinned.prism?.idealNlist ?? 0) > 2);
    assert.ok(
      pinned.embeddedRecords >
        (pinned.prism?.nlist ?? 0) * (pinned.prism?.targetEntries ?? 0) * 2,
    );
    assert.equal(pinned.prism?.needsReindex, false);
    assert.equal(pinned.prism?.reindexReason, null);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
