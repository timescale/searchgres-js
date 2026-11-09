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
  InvalidInputError,
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
import { mockEmbeddingModel } from "./support/embedding.ts";

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
    await assert.rejects(
      () => createIndex(sql, "public", { dimensions: 4 }),
      /^ConflictError: Schema "public" already exists\. createIndex creates a new schema/,
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
    const model = mockEmbeddingModel({});
    const index = await openIndex(sql, schema, { embedding: model });

    assert.equal(index.schema, schema);
    assert.equal(index.vectorType, "halfvec");
    assert.equal(index.dimensions, 4);
    assert.equal(index.embedding, model);
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
    ["model id string", { embedding: "text-embedding-3-small" }],
    ["object without doEmbed", { embedding: { modelId: "x" } }],
    ["non-function truncate", { embedding: noEmbedding, truncate: "24000" }],
    ["unknown key", { embedding: noEmbedding, truncator: noTruncation }],
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
  await assert.rejects(
    () =>
      openIndex(sql, missing, {
        embedding: "text-embedding-3-small",
      } as unknown as OpenIndexOptions),
    /not a model id string .*Vercel AI Gateway/,
  );

  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
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
      () => openIndex(sql, plainSchema, { embedding: noEmbedding }),
      /is not a searchgres index: the schema does not exist$/,
    );
    await sql`create schema ${sql(plainSchema)}`;
    await assert.rejects(
      () => openIndex(sql, plainSchema, { embedding: noEmbedding }),
      InvalidIndexError,
    );

    await createIndex(sql, versionedSchema, { dimensions: 4 });
    await sql`drop index ${sql(versionedSchema)}.record_embedding_hnsw_idx`;
    await assert.rejects(
      () => openIndex(sql, versionedSchema, { embedding: noEmbedding }),
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
      () => openIndex(sql, versionedSchema, { embedding: noEmbedding }),
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

/** Read one effective prism setting through pg_vectorsearch's own inspection function. */
async function prismSetting(
  schema: string,
  name: string,
): Promise<string | undefined> {
  const [row] = await sql<{ readonly setting: string }[]>`
    select setting
    from public.prism_index_settings
    ( pg_catalog.format('%I.record_embedding_prism_idx', ${schema}::text)::pg_catalog.regclass
    )
    where name = ${name}
  `;
  return row?.setting;
}

test("creates, opens, and reindexes prism and hnsw vector indexes", async () => {
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
    assert.equal(await hnswIndex.reindexVectorIndex(), undefined);
    await assert.rejects(
      () =>
        hnswIndex.reindexVectorIndex({
          nlist: 2,
        } as unknown as Parameters<typeof hnswIndex.reindexVectorIndex>[0]),
      InvalidInputError,
    );

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

    // createIndex builds on an empty table, so prism starts with one list.
    assert.equal(await prismSetting(prismHalfvecSchema, "nlist"), "1");
    await prismIndex.upsertMany([
      { content: "one", tree: "docs", embedding: [1, 0, 0, 0] },
      { content: "two", tree: "docs", embedding: [0, 1, 0, 0] },
      { content: "three", tree: "docs", embedding: [0, 0, 1, 0] },
      { content: "four", tree: "docs", embedding: [0, 0, 0, 1] },
    ]);
    assert.equal(await prismSetting(prismHalfvecSchema, "nlist"), "1");
    await prismIndex.reindexVectorIndex();
    assert.equal(await prismSetting(prismHalfvecSchema, "nlist"), "2");

    // A concurrent rebuild restores the caller's session timeouts.
    const singlePool = connectToDatabase(sql.options.database, 1);
    try {
      await singlePool`select pg_catalog.set_config('lock_timeout', '4321ms', false)`;
      await singlePool`select pg_catalog.set_config('statement_timeout', '8765ms', false)`;
      const singlePrism = await openIndex(singlePool, prismHalfvecSchema, {
        embedding: noEmbedding,
      });
      await singlePrism.reindexVectorIndex({
        concurrently: true,
        lockTimeoutMs: 5_000,
        statementTimeoutMs: 30_000,
      });
      assert.equal(await prismSetting(prismHalfvecSchema, "nlist"), "2");

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

test("a prism rebuild sizes its lists from the current row count", async () => {
  const schema = randomTestSchema();
  try {
    await ensureExtensions(sql, { vectorIndex: "prism" });
    await createIndex(sql, schema, {
      dimensions: 4,
      vectorType: "halfvec",
      vectorIndex: { method: "prism" },
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

    // The first rebuild leaves pg_class.reltuples at 4 rows.
    await insertEmbedded(4, 0);
    await index.reindexVectorIndex();
    assert.equal(await prismSetting(schema, "nlist"), "2");

    // Without a fresh ANALYZE, prism would size this rebuild from the stale
    // 4-row estimate and keep 2 lists.
    await insertEmbedded(396, 4);
    await index.reindexVectorIndex();
    assert.ok(Number(await prismSetting(schema, "nlist")) > 2);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
