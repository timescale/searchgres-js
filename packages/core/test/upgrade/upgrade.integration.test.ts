import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import postgres, { type Sql } from "postgres";
import { createIndex, SCHEMA_FORMAT_VERSION } from "../../src/create-index.ts";
import {
  bootstrapMigrations,
  defineMigration,
  executeMigrationFile,
  executeMigrations,
  idempotentMigrations,
  incrementalMigrations,
  type Migration,
  migrationTableMigration,
} from "../../src/db/definitions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "../../src/db/lock.ts";
import { readIndexMarker } from "../../src/db/marker.ts";
import { indexSqlContext, migrationSqlContext } from "../../src/db/template.ts";
import { noEmbedding } from "../../src/embedding.ts";
import {
  InvalidConfigError,
  InvalidIndexError,
  LockTimeoutError,
  SchemaVersionError,
} from "../../src/errors.ts";
import {
  type MigrateIndexOptions,
  migrateIndex,
  recordAppliedMigration,
  runIndexMigrations,
} from "../../src/migrate-index.ts";
import { openIndex } from "../../src/open-index.ts";
import { postgresErrorCode } from "../../src/sql/errors.ts";
import { expectSqlState } from "../support/assert.ts";
import {
  connect,
  connectToDatabase,
  dropTestSchema,
  randomTestSchema,
  schemaExists,
} from "../support/db.ts";
import { mockEmbeddingModel } from "../support/embedding.ts";
import { schemaCatalog } from "../support/schema-catalog.ts";
import {
  cleanupV032Core,
  createFormat2Index,
  getV032Core,
} from "./format-2.ts";

const execFileAsync = promisify(execFile);

let sql: Sql;

before(() => {
  sql = connect();
});

after(async () => {
  await cleanupV032Core();
  await sql.end();
});

function randomRole(prefix = "sgtest_role"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

async function resolvePostgresContainer(port: number): Promise<string | null> {
  if (process.env.TEST_POSTGRES_CONTAINER) {
    return process.env.TEST_POSTGRES_CONTAINER;
  }
  try {
    const { stdout } = await execFileAsync("docker", [
      "ps",
      "--filter",
      `publish=${port}`,
      "--format",
      "{{.Names}}",
    ]);
    const name = stdout.trim().split(/\r?\n/)[0]?.trim();
    return name || null;
  } catch {
    return null;
  }
}

async function runWithStdin(
  command: string,
  args: readonly string[],
  input: string,
): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(
          new Error(`${command} exited with code ${code}: ${stderr}`),
        );
      }
    });
    child.stdin.end(input);
  });
}

async function pollUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

test("adopts populated format-2 indexes across vector types, preserves data/queue/settings, is repeatable, and real v0.3.2 openIndex rejects upgraded schema", async () => {
  const v032 = await getV032Core();
  for (const vectorType of ["halfvec", "vector"] as const) {
    const upgradedSchema = randomTestSchema();
    const freshSchema = randomTestSchema();
    const config = {
      dimensions: 4,
      vectorType,
      bm25: { textConfig: "simple", k1: 1.6, b: 0.4 },
      hnsw: { m: 8, efConstruction: 32 },
    } as const;
    try {
      await createFormat2Index(sql, upgradedSchema, config);

      const oldHandle = await v032.openIndex(sql, upgradedSchema, {
        embedding: v032.noEmbedding,
      });
      assert.equal(oldHandle.schema, upgradedSchema);
      assert.equal(oldHandle.vectorType, vectorType);
      assert.equal(oldHandle.dimensions, 4);

      const vectorCast =
        vectorType === "vector" ? "public.vector(4)" : "public.halfvec(4)";
      const [withVector] = await sql<
        {
          readonly id: string;
          readonly version: string;
          readonly version_hash: string;
          readonly content_version: number;
        }[]
      >`
          insert into ${sql(upgradedSchema)}.record
          ( id
          , content
          , meta
          , tree
          , temporal
          , name
          , embedding
          )
          values
          ( '019571e2-7c00-7000-8000-000000000001'::uuid
          , 'alpha search indexing guide'
          , '{"topic":"db","tier":1}'::jsonb
          , 'docs.guides'::public.ltree
          , '[2026-01-01T00:00:00Z,2026-02-01T00:00:00Z)'::tstzrange
          , 'alpha'
          , ${sql.unsafe(`'[1,0,0,0]'::${vectorCast}`)}
          )
          returning id, version, version_hash, content_version
        `;
      assert.ok(withVector);

      const [patched] = await sql<
        {
          readonly updated: boolean;
          readonly version: string;
          readonly version_hash: string;
        }[]
      >`
          select updated, version, version_hash
          from ${sql(upgradedSchema)}.patch_record
          ( ${withVector.id}::uuid
          , ${withVector.version_hash}
          , '{"meta":{"topic":"db","tier":2}}'::jsonb
          , null
          )
        `;
      assert.equal(patched?.updated, true);
      assert.equal(patched?.version, "2");

      await sql`
          insert into ${sql(upgradedSchema)}.record (id, content, tree, name)
          values
            ( '019571e2-7c00-7000-8000-000000000002'::uuid
            , 'beta pending async embedding'
            , 'docs.pending'::public.ltree
            , 'beta'
            )
          , ( '019571e2-7c00-7000-8000-000000000003'::uuid
            , 'gamma leased embedding item'
            , 'docs.leased'::public.ltree
            , 'gamma'
            )
          , ( '019571e2-7c00-7000-8000-000000000004'::uuid
            , 'delta failed embedding item'
            , 'docs.failed'::public.ltree
            , 'delta'
            )
        `;
      await sql`
          update ${sql(upgradedSchema)}.embedding_queue set
            attempts = 1
          , visible_at = pg_catalog.now() + interval '10 minutes'
          , updated_at = '2026-01-15T00:00:00Z'::timestamptz
          where record_id = '019571e2-7c00-7000-8000-000000000003'::uuid
        `;
      await sql`
          update ${sql(upgradedSchema)}.embedding_queue set
            outcome = 'failed'
          , attempts = 5
          , last_error = 'provider timeout'
          , updated_at = '2026-01-15T00:05:00Z'::timestamptz
          where record_id = '019571e2-7c00-7000-8000-000000000004'::uuid
        `;

      const recordsBefore = Array.from(
        await sql`
            select
              id
            , content
            , meta
            , tree::text as tree
            , temporal::text as temporal
            , name
            , embedding::text as embedding
            , content_version
            , version
            , version_hash
            , created_at
            , updated_at
            from ${sql(upgradedSchema)}.record
            order by id
          `,
      );
      const queueBefore = Array.from(
        await sql`
            select
              id
            , record_id
            , content_version
            , visible_at
            , outcome
            , attempts
            , last_error
            , created_at
            , updated_at
            from ${sql(upgradedSchema)}.embedding_queue
            order by id
          `,
      );

      await assert.rejects(
        () => openIndex(sql, upgradedSchema, { embedding: noEmbedding }),
        (error: unknown) => {
          assert.ok(error instanceof SchemaVersionError);
          assert.equal(error.schemaVersion, "2");
          assert.equal(error.supportedVersion, "3");
          assert.match(error.message, /migrateIndex/);
          return true;
        },
      );

      const firstResult = await migrateIndex(sql, upgradedSchema);
      assert.deepEqual(firstResult, {
        schema: upgradedSchema,
        fromVersion: "2",
        toVersion: "3",
        applied: [],
      });
      await createIndex(sql, freshSchema, config);

      assert.deepEqual(
        await schemaCatalog(sql, upgradedSchema),
        await schemaCatalog(sql, freshSchema),
      );

      const recordsAfter = Array.from(
        await sql`
            select
              id
            , content
            , meta
            , tree::text as tree
            , temporal::text as temporal
            , name
            , embedding::text as embedding
            , content_version
            , version
            , version_hash
            , created_at
            , updated_at
            from ${sql(upgradedSchema)}.record
            order by id
          `,
      );
      const queueAfter = Array.from(
        await sql`
            select
              id
            , record_id
            , content_version
            , visible_at
            , outcome
            , attempts
            , last_error
            , created_at
            , updated_at
            from ${sql(upgradedSchema)}.embedding_queue
            order by id
          `,
      );
      assert.deepEqual(recordsAfter, recordsBefore);
      assert.deepEqual(queueAfter, queueBefore);

      // Real v0.3.2 openIndex rejects the upgraded version-3 index (version
      // column is now bigint rather than v0.3.2's text).
      await assert.rejects(
        () =>
          v032.openIndex(sql, upgradedSchema, {
            embedding: v032.noEmbedding,
          }),
        (error: unknown) => {
          assert.equal((error as { code?: string }).code, "INVALID_INDEX");
          assert.equal((error as { schema?: string }).schema, upgradedSchema);
          return true;
        },
      );

      const [ledgerBeforeRepeat] = await sql<
        {
          readonly name: string;
          readonly applied_at_version: string;
          readonly applied_at: Date;
        }[]
      >`
          select name, applied_at_version, applied_at
          from ${sql(upgradedSchema)}.migration
        `;
      assert.ok(ledgerBeforeRepeat);
      const secondResult = await migrateIndex(sql, upgradedSchema);
      assert.deepEqual(secondResult, {
        schema: upgradedSchema,
        fromVersion: "3",
        toVersion: "3",
        applied: [],
      });
      const ledgerAfterRepeat = await sql<
        {
          readonly name: string;
          readonly applied_at_version: string;
          readonly applied_at: Date;
        }[]
      >`
          select name, applied_at_version, applied_at
          from ${sql(upgradedSchema)}.migration
        `;
      assert.deepEqual(Array.from(ledgerAfterRepeat), [ledgerBeforeRepeat]);
      assert.deepEqual(
        await schemaCatalog(sql, upgradedSchema),
        await schemaCatalog(sql, freshSchema),
      );

      const index = await openIndex(sql, upgradedSchema, {
        embedding: mockEmbeddingModel({
          "beta pending async embedding": [0, 1, 0, 0],
          "alpha search indexing": [1, 0, 0, 0],
        }),
      });
      assert.equal(index.vectorType, vectorType);
      assert.equal(index.dimensions, 4);

      const statsBefore = await index.queueStats();
      assert.equal(statsBefore.pending, 2);
      assert.equal(statsBefore.inFlight, 1);
      assert.equal(statsBefore.failed, 1);

      const processed = await index.processEmbeddings({ maxBatches: 1 });
      assert.equal(processed.embedded, 1);

      const fulltext = await index.search({ fulltext: "alpha" });
      assert.equal(fulltext[0]?.id, withVector.id);
      const semantic = await index.search({
        semantic: "alpha search indexing",
        limit: 2,
      });
      assert.equal(semantic[0]?.id, withVector.id);
      const hybrid = await index.search({
        fulltext: "alpha",
        semantic: "alpha search indexing",
        limit: 2,
      });
      assert.equal(hybrid[0]?.id, withVector.id);
      const filtered = await index.search({
        filter: { and: [{ tree: "docs" }, { meta: { tier: 2 } }] },
      });
      assert.deepEqual(
        filtered.map((r) => r.id),
        [withVector.id],
      );
      assert.deepEqual(
        await Promise.all([
          index.countTree({ tree: "docs" }),
          index.countTree({ lquery: "docs.*" }),
          index.countTree({ ltxtquery: "docs" }),
        ]),
        [
          { count: 4, capped: false },
          { count: 4, capped: false },
          { count: 4, capped: false },
        ],
      );
    } finally {
      await dropTestSchema(sql, upgradedSchema);
      await dropTestSchema(sql, freshSchema);
    }
  }
});

test("direct, sequential, and skipped-version upgrades with trigger-aware backfills and signature changes converge to fresh catalog and data", async () => {
  const freshSchema = randomTestSchema();
  const sequentialSchema = randomTestSchema();
  const skippedSchema = randomTestSchema();

  const seedCreatedAt = "2026-01-01T00:00:00.000Z";
  const migration002Seed: Migration = defineMigration(
    "incremental",
    "incremental/002_seed_fixture.sql",
    `
      insert into {{schema_ident}}.record
      ( id
      , content
      , meta
      , tree
      , name
      , embedding
      , content_version
      , version
      , version_hash
      , created_at
      , updated_at
      )
      values
      ( '019571e2-7c00-7000-8000-000000000010'::uuid
      , 'record before upgrades'
      , '{"origin":"v2"}'::jsonb
      , 'docs.seq'::public.ltree
      , 'item'
      , '[1,0,0,0]'::public.halfvec(4)
      , 1
      , 1
      , pg_catalog.md5
        (
          pg_catalog.jsonb_build_object
          ( 'tree', 'docs.seq'
          , 'name', 'item'
          , 'meta', '{"origin":"v2"}'::jsonb
          , 'temporal', null
          , 'content', 'record before upgrades'
          )::text
        )
      , '${seedCreatedAt}'::timestamptz
      , '${seedCreatedAt}'::timestamptz
      )
      on conflict (id) do nothing;
    `,
  );

  const triggersFile = idempotentMigrations[0];
  assert.ok(triggersFile);
  const migration003Backfill: Migration = defineMigration(
    "incremental",
    "incremental/003_backfill_meta_flag.sql",
    `${triggersFile.sql}
      update {{schema_ident}}.record set
        meta = coalesce(meta, '{}'::jsonb) || '{"backfilled":true}'::jsonb
      where not (coalesce(meta, '{}'::jsonb) ? 'backfilled');
    `,
  );

  const step2IdempotentProbeV1: Migration = defineMigration(
    "idempotent",
    "idempotent/005_probe.sql",
    `
      create or replace function {{schema_ident}}.migration_probe(_x integer)
      returns integer
      as $func$
        select _x + 1
      $func$ language sql immutable security invoker
      ;
    `,
  );

  const migration004DropOldSignature: Migration = defineMigration(
    "incremental",
    "incremental/004_replace_helper_signature.sql",
    `
      drop function if exists {{schema_ident}}.migration_probe
      ( pg_catalog.int4
      );
    `,
  );
  const step3IdempotentProbeV2: Migration = defineMigration(
    "idempotent",
    "idempotent/005_probe.sql",
    `
      create or replace function {{schema_ident}}.migration_probe
      ( _label text
      , _x integer default 1
      )
      returns text
      as $func$
        select _label || ':' || (_x + 2)::text
      $func$ language sql immutable security invoker
      ;
    `,
  );

  const step2Migrations = [
    ...incrementalMigrations,
    migration002Seed,
    migration003Backfill,
  ];
  const step2Idempotents = [...idempotentMigrations, step2IdempotentProbeV1];

  const step3Migrations = [...step2Migrations, migration004DropOldSignature];
  const step3Idempotents = [...idempotentMigrations, step3IdempotentProbeV2];

  try {
    await sql.begin(async (tx) => {
      const context = indexSqlContext(
        freshSchema,
        { dimensions: 4 },
        "'english'",
      );
      await tx`set local search_path to pg_catalog, public, pg_temp`;
      await executeMigrations(
        tx,
        context,
        bootstrapMigrations,
        SCHEMA_FORMAT_VERSION,
      );
      await runIndexMigrations(
        tx,
        context,
        "fresh",
        step3Migrations,
        step3Idempotents,
      );
    });

    await createFormat2Index(sql, sequentialSchema, { dimensions: 4 });
    await migrateIndex(sql, sequentialSchema);
    await sql.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path to pg_catalog, public, pg_temp`;
      const context = migrationSqlContext(sequentialSchema, {
        vectorType: "halfvec",
        dimensions: 4,
      });
      const applied = await runIndexMigrations(
        tx,
        context,
        "existing",
        step2Migrations,
        step2Idempotents,
      );
      assert.deepEqual(applied, ["002_seed_fixture", "003_backfill_meta_flag"]);
    });
    const [step2Probe] = await sql<{ readonly v: number }[]>`
      select ${sql(sequentialSchema)}.migration_probe(10) as v
    `;
    assert.equal(step2Probe?.v, 11);

    await sql.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path to pg_catalog, public, pg_temp`;
      const context = migrationSqlContext(sequentialSchema, {
        vectorType: "halfvec",
        dimensions: 4,
      });
      const applied = await runIndexMigrations(
        tx,
        context,
        "existing",
        step3Migrations,
        step3Idempotents,
      );
      assert.deepEqual(applied, ["004_replace_helper_signature"]);
    });

    // 3. Skipped-version upgrade: adopt v2 and run step3Migrations + step3Idempotents
    // in a SINGLE pass without stopping at v3 or running step2Idempotents first.
    await createFormat2Index(sql, skippedSchema, { dimensions: 4 });
    await sql.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path to pg_catalog, public, pg_temp`;
      const context = migrationSqlContext(skippedSchema, {
        vectorType: "halfvec",
        dimensions: 4,
      });
      await executeMigrationFile(
        tx,
        context,
        migrationTableMigration,
        SCHEMA_FORMAT_VERSION,
      );
      await recordAppliedMigration(tx, skippedSchema, "001_initial", "2");
      const applied = await runIndexMigrations(
        tx,
        context,
        "existing",
        step3Migrations,
        step3Idempotents,
      );
      assert.deepEqual(applied, [
        "002_seed_fixture",
        "003_backfill_meta_flag",
        "004_replace_helper_signature",
      ]);
    });

    const freshCatalog = await schemaCatalog(sql, freshSchema);
    const sequentialCatalog = await schemaCatalog(sql, sequentialSchema);
    const skippedCatalog = await schemaCatalog(sql, skippedSchema);
    assert.deepEqual(sequentialCatalog, freshCatalog);
    assert.deepEqual(skippedCatalog, freshCatalog);

    const readRowState = async (target: string) => {
      const [row] = await sql<
        {
          readonly meta: Record<string, unknown>;
          readonly content_version: number;
          readonly version: string;
          readonly version_hash: string;
          readonly created_at: Date;
          readonly updated_elevated: boolean;
        }[]
      >`
        select
          meta
        , content_version
        , version
        , version_hash
        , created_at
        , (updated_at > created_at) as updated_elevated
        from ${sql(target)}.record
        where id = '019571e2-7c00-7000-8000-000000000010'::uuid
      `;
      const queueRows = await sql`
        select id from ${sql(target)}.embedding_queue
      `;
      return { row, queueCount: queueRows.length };
    };

    const freshState = await readRowState(freshSchema);
    const sequentialState = await readRowState(sequentialSchema);
    const skippedState = await readRowState(skippedSchema);
    assert.deepEqual(sequentialState, freshState);
    assert.deepEqual(skippedState, freshState);
    assert.deepEqual(freshState.row?.meta, {
      origin: "v2",
      backfilled: true,
    });
    assert.equal(freshState.row?.version, "2");
    assert.equal(freshState.row?.content_version, 1);
    assert.equal(freshState.row?.updated_elevated, true);
    assert.equal(freshState.queueCount, 0);

    for (const target of [freshSchema, sequentialSchema, skippedSchema]) {
      const [probe] = await sql<{ readonly out: string }[]>`
        select ${sql(target)}.migration_probe('ok', 5) as out
      `;
      assert.equal(probe?.out, "ok:7");
      const rows = await sql<{ readonly name: string }[]>`
        select name from ${sql(target)}.migration order by name collate "C"
      `;
      assert.deepEqual(
        rows.map((r) => r.name),
        [
          "001_initial",
          "002_seed_fixture",
          "003_backfill_meta_flag",
          "004_replace_helper_signature",
        ],
      );
    }
  } finally {
    await dropTestSchema(sql, freshSchema);
    await dropTestSchema(sql, sequentialSchema);
    await dropTestSchema(sql, skippedSchema);
  }
});

test("enforces version bounds, numeric comparison of 10 vs 3, and descriptive ledger state errors without DDL", async () => {
  const plainSchema = randomTestSchema();
  const format2Schema = randomTestSchema();
  const format3Schema = randomTestSchema();
  try {
    await sql`create schema ${sql(plainSchema)}`;
    await assert.rejects(
      () => migrateIndex(sql, plainSchema),
      InvalidIndexError,
    );

    const invalidOptions: readonly [string, unknown][] = [
      ["negative lock timeout", { lockTimeoutMs: -1 }],
      ["fractional transaction timeout", { transactionTimeoutMs: 1.5 }],
      ["unknown option", { dryRun: true }],
    ];
    for (const [label, opts] of invalidOptions) {
      await assert.rejects(
        () => migrateIndex(sql, plainSchema, opts as MigrateIndexOptions),
        (error: unknown) => {
          assert.ok(error instanceof InvalidConfigError, label);
          assert.match(error.message, /^Invalid migrateIndex options: /, label);
          return true;
        },
      );
    }

    await createFormat2Index(sql, format2Schema, { dimensions: 4 });

    for (const badVersion of ["1", "4", "10", "0", "-1", "03", "2.0", "abc"]) {
      await sql`update ${sql(format2Schema)}.version set version = ${badVersion}`;
      await assert.rejects(
        () => migrateIndex(sql, format2Schema),
        (error: unknown) => {
          assert.ok(error instanceof SchemaVersionError, badVersion);
          assert.equal(error.schemaVersion, badVersion);
          assert.equal(error.supportedVersion, "3");
          if (badVersion === "4" || badVersion === "10") {
            assert.match(
              error.message,
              new RegExp(`newer schema format ${badVersion}`),
            );
          } else {
            assert.match(error.message, /Create a new index and reindex/);
          }
          return true;
        },
      );
      await assert.rejects(
        () => openIndex(sql, format2Schema, { embedding: noEmbedding }),
        SchemaVersionError,
      );
      const [ledgerExists] = await sql<{ readonly present: boolean }[]>`
        select pg_catalog.to_regclass(${`${format2Schema}.migration`}) is not null as present
      `;
      assert.equal(ledgerExists?.present, false, badVersion);
    }

    await sql`update ${sql(format2Schema)}.version set version = '2'`;
    await sql`create view ${sql(format2Schema)}.migration as select '001_initial'::text as name`;
    await assert.rejects(
      () => migrateIndex(sql, format2Schema),
      (error: unknown) => {
        assert.ok(error instanceof InvalidIndexError);
        assert.match(
          error.message,
          /unexpected migration relation present on schema format 2/,
        );
        return true;
      },
    );
    await sql`drop view ${sql(format2Schema)}.migration`;

    await sql`
      create table ${sql(format2Schema)}.migration
      ( name text not null primary key
      , applied_at_version bigint not null
      , applied_at timestamptz not null default pg_catalog.clock_timestamp()
      )
    `;
    await assert.rejects(
      () => migrateIndex(sql, format2Schema),
      (error: unknown) => {
        assert.ok(error instanceof InvalidIndexError);
        assert.match(
          error.message,
          /unexpected migration relation present on schema format 2/,
        );
        return true;
      },
    );
    const [stillV2] = await sql<{ readonly version: string }[]>`
      select version from ${sql(format2Schema)}.version
    `;
    assert.equal(stillV2?.version, "2");

    await createIndex(sql, format3Schema, { dimensions: 4 });
    await sql`drop table ${sql(format3Schema)}.migration`;
    for (const op of [
      () => openIndex(sql, format3Schema, { embedding: noEmbedding }),
      () => migrateIndex(sql, format3Schema),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof InvalidIndexError);
        assert.match(
          error.message,
          /missing or invalid migration table for schema format 3/,
        );
        return true;
      });
    }
    const [stillDropped] = await sql<{ readonly present: boolean }[]>`
      select pg_catalog.to_regclass(${`${format3Schema}.migration`}) is not null as present
    `;
    assert.equal(stillDropped?.present, false);

    await sql`create table ${sql(format3Schema)}.migration (name text primary key)`;
    for (const op of [
      () => openIndex(sql, format3Schema, { embedding: noEmbedding }),
      () => migrateIndex(sql, format3Schema),
    ]) {
      await assert.rejects(op, (error: unknown) => {
        assert.ok(error instanceof InvalidIndexError);
        assert.match(
          error.message,
          /missing or invalid migration table for schema format 3/,
        );
        return true;
      });
    }
  } finally {
    await dropTestSchema(sql, plainSchema);
    await dropTestSchema(sql, format2Schema);
    await dropTestSchema(sql, format3Schema);
  }
});

test("pins transaction-local search_path during migration and leaves caller search_path unchanged", async () => {
  const indexSchema = randomTestSchema();
  const decoySchema = randomTestSchema();
  const connection = connectToDatabase(sql.options.database, 1);
  try {
    await createFormat2Index(connection, indexSchema, { dimensions: 4 });
    await connection`create schema ${connection(decoySchema)}`;
    await connection`create table ${connection(decoySchema)}.version (bad int)`;
    await connection`create table ${connection(decoySchema)}.migration (bad int)`;
    await connection`create table ${connection(decoySchema)}.record (bad int)`;

    const callerSearchPath = `${decoySchema}, pg_catalog`;
    await connection`select pg_catalog.set_config('search_path', ${callerSearchPath}, false)`;
    const [before] = await connection<{ readonly path: string }[]>`
      select pg_catalog.current_setting('search_path') as path
    `;
    assert.equal(before?.path, callerSearchPath);

    await migrateIndex(connection, indexSchema);

    const [afterSuccess] = await connection<{ readonly path: string }[]>`
      select pg_catalog.current_setting('search_path') as path
    `;
    assert.equal(afterSuccess?.path, callerSearchPath);

    await assert.rejects(
      () => migrateIndex(connection, decoySchema),
      InvalidIndexError,
    );
    const [afterFailure] = await connection<{ readonly path: string }[]>`
      select pg_catalog.current_setting('search_path') as path
    `;
    assert.equal(afterFailure?.path, callerSearchPath);
  } finally {
    await connection`reset all`;
    await dropTestSchema(connection, decoySchema);
    await dropTestSchema(connection, indexSchema);
    await connection.end();
  }
});

test("enforces strict schema ownership (with SET ROLE support for NOLOGIN owners), preserves custom grants across same-signature and signature-changing migrations via proacl, and opens without SELECT on migration", async () => {
  const ownerRole = randomRole("sgtest_owner");
  const memberRole = randomRole("sgtest_member");
  const readerRole = randomRole("sgtest_reader");
  const outsiderRole = randomRole("sgtest_outsider");
  const schema = randomTestSchema();
  let ownerSql: Sql | undefined;
  let memberSql: Sql | undefined;
  let readerSql: Sql | undefined;
  let outsiderSql: Sql | undefined;
  try {
    for (const role of [ownerRole, memberRole, readerRole, outsiderRole]) {
      await sql.unsafe(`create role "${role}" login`);
    }
    await sql.unsafe(
      `grant create on database "${sql.options.database}" to "${ownerRole}"`,
    );
    await sql.unsafe(`grant "${ownerRole}" to "${memberRole}"`);

    const baseUrl = new URL(
      process.env.TEST_DATABASE_URL ??
        "postgresql://postgres@127.0.0.1:5432/postgres",
    );
    const connectAs = (role: string) => {
      const u = new URL(baseUrl);
      u.username = role;
      u.password = "";
      return postgres(u.toString(), { max: 1, onnotice: () => {} });
    };
    ownerSql = connectAs(ownerRole);
    memberSql = connectAs(memberRole);
    readerSql = connectAs(readerRole);
    outsiderSql = connectAs(outsiderRole);

    await createFormat2Index(ownerSql, schema, { dimensions: 4 });
    await ownerSql`
      insert into ${ownerSql(schema)}.record (content, tree, name, embedding)
      values ('owned record', 'docs'::public.ltree, 'one', '[1,0,0,0]'::public.halfvec(4))
    `;

    await ownerSql.unsafe(
      `revoke all on function "${schema}".get_record(uuid) from public`,
    );
    await ownerSql.unsafe(
      `grant execute on function "${schema}".get_record(uuid) to "${readerRole}" with grant option`,
    );

    // Grant outsiderRole USAGE on schema AND SELECT on version/record/queue so
    // readIndexMarker succeeds and execution reaches the TypeScript ownership check.
    await ownerSql.unsafe(
      `grant usage on schema "${schema}" to "${outsiderRole}"`,
    );
    await ownerSql.unsafe(
      `grant select on table "${schema}".version, "${schema}".record, "${schema}".embedding_queue to "${outsiderRole}"`,
    );
    assert.equal(await readIndexMarker(outsiderSql, schema), "2");

    // Both outsiderRole and memberRole (without SET ROLE) are rejected by the
    // strict current_user = nspowner check so adoption never creates a ledger
    // table owned by the wrong role.
    for (const nonOwnerSql of [outsiderSql, memberSql]) {
      await assert.rejects(
        () => migrateIndex(nonOwnerSql!, schema),
        (error: unknown) => {
          assert.equal(postgresErrorCode(error), "42501");
          assert.match(
            (error as Error).message,
            /only the schema owner can migrate a searchgres index/,
          );
          return true;
        },
      );
    }

    // When memberRole assumes ownerRole via SET ROLE, it adopts format 2 -> 3
    // with the ledger owned by ownerRole, and ownerRole can subsequently run
    // migrateIndex directly without 42501 on <schema>.migration.
    await memberSql.unsafe(`set role "${ownerRole}"`);
    const migrated = await migrateIndex(memberSql, schema);
    assert.deepEqual(migrated, {
      schema,
      fromVersion: "2",
      toVersion: "3",
      applied: [],
    });
    assert.deepEqual(await migrateIndex(ownerSql, schema), {
      schema,
      fromVersion: "3",
      toVersion: "3",
      applied: [],
    });

    const [fnPrivileges] = await sql<
      {
        readonly public_exec: boolean;
        readonly reader_exec: boolean;
        readonly reader_grant_opt: boolean;
        readonly outsider_exec: boolean;
      }[]
    >`
      select
        pg_catalog.has_function_privilege('public', ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE') as public_exec
      , pg_catalog.has_function_privilege(${readerRole}, ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE') as reader_exec
      , pg_catalog.has_function_privilege(${readerRole}, ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE WITH GRANT OPTION') as reader_grant_opt
      , pg_catalog.has_function_privilege(${outsiderRole}, ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE') as outsider_exec
    `;
    assert.deepEqual(fnPrivileges, {
      public_exec: false,
      reader_exec: true,
      reader_grant_opt: true,
      outsider_exec: false,
    });

    await ownerSql.unsafe(`
      create function "${schema}".sig_probe(_x integer)
      returns integer
      language sql immutable security invoker
      as $$ select _x + 1 $$;
      revoke all on function "${schema}".sig_probe(integer) from public;
      grant execute on function "${schema}".sig_probe(integer) to "${readerRole}" with grant option;
      create view "${schema}".dependent_caller_view as select "${schema}".sig_probe(1) as val;
    `);

    const sigChangeContext = migrationSqlContext(schema, {
      vectorType: "halfvec",
      dimensions: 4,
    });
    // The migration SQL does NOT hardcode readerRole: it inspects pg_proc.proacl
    // via pg_catalog.aclexplode before dropping the old signature, then replays
    // the caller's custom EXECUTE grants onto the new signature.
    const sigDropMigration: Migration = defineMigration(
      "incremental",
      "incremental/002_drop_sig_probe.sql",
      `
        do $preserve_sig_probe_acl$
        declare
          _old_oid oid;
          _has_custom_acl boolean := false;
          _public_exec boolean := false;
          _grant record;
          _acl_cmds text[] := array[]::text[];
          _cmd text;
        begin
          select p.oid, (p.proacl is not null)
          into _old_oid, _has_custom_acl
          from pg_catalog.pg_proc p
          where p.oid = '{{schema_ident}}.sig_probe(pg_catalog.int4)'::pg_catalog.regprocedure;

          if _has_custom_acl then
            for _grant in
              select
                a.grantee
              , a.is_grantable
              from pg_catalog.pg_proc p
              cross join lateral pg_catalog.aclexplode(p.proacl) a
              where p.oid = _old_oid
              and a.privilege_type = 'EXECUTE'
            loop
              if _grant.grantee = 0 then
                _public_exec := true;
              else
                _acl_cmds := array_append
                ( _acl_cmds
                , pg_catalog.format
                  ( 'grant execute on function {{schema_ident}}.sig_probe(pg_catalog.text, pg_catalog.int4) to %I%s'
                  , _grant.grantee::pg_catalog.regrole::text
                  , case when _grant.is_grantable then ' with grant option' else '' end
                  )
                );
              end if;
            end loop;
          end if;

          drop function if exists {{schema_ident}}.sig_probe
          ( pg_catalog.int4
          );

          create or replace function {{schema_ident}}.sig_probe
          ( _prefix text
          , _x integer
          )
          returns text
          as $func$
            select _prefix || ':' || _x::text
          $func$ language sql immutable security invoker
          ;

          if _has_custom_acl then
            if not _public_exec then
              revoke all on function {{schema_ident}}.sig_probe(pg_catalog.text, pg_catalog.int4) from public;
            end if;
            foreach _cmd in array _acl_cmds loop
              execute _cmd;
            end loop;
          end if;
        end;
        $preserve_sig_probe_acl$;
      `,
    );
    const sigIdempotentV2: Migration = defineMigration(
      "idempotent",
      "idempotent/005_sig_probe.sql",
      `
        create or replace function {{schema_ident}}.sig_probe
        ( _prefix text
        , _x integer
        )
        returns text
        as $func$
          select _prefix || ':' || _x::text
        $func$ language sql immutable security invoker
        ;
      `,
    );

    await expectSqlState(
      () =>
        ownerSql!.begin("isolation level read committed", async (tx) => {
          await tx`set local search_path to pg_catalog, public, pg_temp`;
          await runIndexMigrations(
            tx,
            sigChangeContext,
            "existing",
            [...incrementalMigrations, sigDropMigration],
            [...idempotentMigrations, sigIdempotentV2],
          );
        }),
      "2BP01",
    );

    await ownerSql.unsafe(`drop view "${schema}".dependent_caller_view`);
    await ownerSql.begin("isolation level read committed", async (tx) => {
      await tx`set local search_path to pg_catalog, public, pg_temp`;
      await runIndexMigrations(
        tx,
        sigChangeContext,
        "existing",
        [...incrementalMigrations, sigDropMigration],
        [...idempotentMigrations, sigIdempotentV2],
      );
    });

    const [sigPrivileges] = await sql<
      {
        readonly old_exists: boolean;
        readonly public_exec: boolean;
        readonly reader_exec: boolean;
        readonly reader_grant_opt: boolean;
        readonly outsider_exec: boolean;
      }[]
    >`
      select
        pg_catalog.to_regprocedure(${`${schema}.sig_probe(integer)`}) is not null as old_exists
      , pg_catalog.has_function_privilege('public', ${`${schema}.sig_probe(text, integer)`}::pg_catalog.regprocedure, 'EXECUTE') as public_exec
      , pg_catalog.has_function_privilege(${readerRole}, ${`${schema}.sig_probe(text, integer)`}::pg_catalog.regprocedure, 'EXECUTE') as reader_exec
      , pg_catalog.has_function_privilege(${readerRole}, ${`${schema}.sig_probe(text, integer)`}::pg_catalog.regprocedure, 'EXECUTE WITH GRANT OPTION') as reader_grant_opt
      , pg_catalog.has_function_privilege(${outsiderRole}, ${`${schema}.sig_probe(text, integer)`}::pg_catalog.regprocedure, 'EXECUTE') as outsider_exec
    `;
    assert.deepEqual(sigPrivileges, {
      old_exists: false,
      public_exec: false,
      reader_exec: true,
      reader_grant_opt: true,
      outsider_exec: false,
    });

    await ownerSql.unsafe(
      `grant usage on schema "${schema}" to "${readerRole}"`,
    );
    await ownerSql.unsafe(
      `grant select on table "${schema}".version, "${schema}".record, "${schema}".embedding_queue to "${readerRole}"`,
    );
    await ownerSql.unsafe(
      `revoke all on table "${schema}".migration from public, "${readerRole}"`,
    );

    await expectSqlState(
      () => readerSql!`select count(*) from ${readerSql!(schema)}.migration`,
      "42501",
    );

    const readerIndex = await openIndex(readerSql, schema, {
      embedding: noEmbedding,
    });
    const results = await readerIndex.search({ filter: { tree: "docs" } });
    assert.equal(results.length, 1);
    assert.equal(results[0]?.content, "owned record");
  } finally {
    await ownerSql?.end();
    await memberSql?.end();
    await readerSql?.end();
    await outsiderSql?.end();
    await dropTestSchema(sql, schema);
    for (const role of [readerRole, outsiderRole, memberRole, ownerRole]) {
      await sql.unsafe(`drop owned by "${role}" cascade`).catch(() => {});
      await sql.unsafe(`drop role if exists "${role}"`);
    }
  }
});

test("rolls back late failures after ledger creation and idempotent replacement, and serializes concurrent migrateIndex calls via pg_locks", async () => {
  const schema = randomTestSchema();
  const connA = connectToDatabase(sql.options.database, 1);
  const connB = connectToDatabase(sql.options.database, 1);
  const blocker = connectToDatabase(sql.options.database, 1);
  try {
    await createFormat2Index(sql, schema, { dimensions: 4 });
    await sql`
      insert into ${sql(schema)}.record (id, content, tree, name, embedding)
      values
        ( '019571e2-7c00-7000-8000-000000000099'::uuid
        , 'rollback witness'
        , 'docs.witness'::public.ltree
        , 'witness'
        , '[1,0,0,0]'::public.halfvec(4)
        )
    `;
    const catalogBeforeRollback = await schemaCatalog(sql, schema);
    const recordsBeforeRollback = Array.from(
      await sql`
        select id, content, tree::text as tree, name, version, version_hash
        from ${sql(schema)}.record
      `,
    );

    let sawInTransactionMutations = false;
    await expectSqlState(
      () =>
        sql.begin("isolation level read committed", async (tx) => {
          await tx`set local search_path to pg_catalog, public, pg_temp`;
          const context = migrationSqlContext(schema, {
            vectorType: "halfvec",
            dimensions: 4,
          });
          await executeMigrationFile(
            tx,
            context,
            migrationTableMigration,
            SCHEMA_FORMAT_VERSION,
          );
          await recordAppliedMigration(tx, schema, "001_initial", "2");

          const modifiedDeleteRecord: Migration = defineMigration(
            "idempotent",
            "idempotent/005_modified_delete.sql",
            `
              create or replace function {{schema_ident}}.delete_record(_id uuid)
              returns boolean
              language sql volatile security invoker
              set search_path to pg_catalog, public, pg_temp
              as $function$
                -- transient body replacement before failure
                with deleted as (
                  delete from {{schema_ident}}.record m
                  where m.id operator(pg_catalog.=) _id
                  returning 1
                )
                select exists (select 1 from deleted)
              $function$;
            `,
          );
          await executeMigrationFile(
            tx,
            context,
            modifiedDeleteRecord,
            SCHEMA_FORMAT_VERSION,
          );

          const [ledgerInTx] = await tx<{ readonly n: number }[]>`
            select count(*)::int as n from ${tx(schema)}.migration
          `;
          const [fnBodyInTx] = await tx<{ readonly prosrc: string }[]>`
            select p.prosrc
            from pg_catalog.pg_proc p
            join pg_catalog.pg_namespace n on n.oid = p.pronamespace
            where n.nspname = ${schema} and p.proname = 'delete_record'
          `;
          assert.equal(ledgerInTx?.n, 1);
          assert.match(
            fnBodyInTx?.prosrc ?? "",
            /transient body replacement before failure/,
          );
          sawInTransactionMutations = true;

          await runIndexMigrations(
            tx,
            context,
            "existing",
            incrementalMigrations,
            [
              ...idempotentMigrations,
              defineMigration(
                "idempotent",
                "idempotent/999_broken.sql",
                "create or replace function {{schema_ident}}.broken() returns pg_catalog.no_such_type language sql as $$ select 1 $$;",
              ),
            ],
          );
        }),
      "42704",
    );
    assert.equal(sawInTransactionMutations, true);
    assert.equal(await readIndexMarker(sql, schema), "2");
    const [noLedger] = await sql<{ readonly present: boolean }[]>`
      select pg_catalog.to_regclass(${`${schema}.migration`}) is not null as present
    `;
    assert.equal(noLedger?.present, false);
    assert.deepEqual(await schemaCatalog(sql, schema), catalogBeforeRollback);
    assert.deepEqual(
      Array.from(
        await sql`
          select id, content, tree::text as tree, name, version, version_hash
          from ${sql(schema)}.record
        `,
      ),
      recordsBeforeRollback,
    );

    const [key1, key2] = advisoryLockKey(schema);
    let locked!: () => void;
    let release!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const releaseHolder = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = connA.begin(async (tx) => {
      await acquireAdvisoryLock(tx, [key1, key2]);
      locked();
      await releaseHolder;
    });
    await lockHeld;
    try {
      await assert.rejects(
        () => migrateIndex(connB, schema, { lockTimeoutMs: 50 }),
        LockTimeoutError,
      );
    } finally {
      release();
      await holder;
    }

    await connB`set session characteristics as transaction isolation level repeatable read`;
    let rowLocked!: () => void;
    let releaseRowLock!: () => void;
    const rowLockHeld = new Promise<void>((resolve) => {
      rowLocked = resolve;
    });
    const waitReleaseRowLock = new Promise<void>((resolve) => {
      releaseRowLock = resolve;
    });

    const rowLockTask = blocker.begin(async (tx) => {
      await tx`select version from ${tx(schema)}.version for update`;
      rowLocked();
      await waitReleaseRowLock;
    });
    await rowLockHeld;

    const firstMigrator = migrateIndex(connA, schema, {
      lockTimeoutMs: 10_000,
    });

    await pollUntil(async () => {
      const [row] = await sql<{ readonly holding: boolean }[]>`
        select exists
        (
          select 1
          from pg_catalog.pg_locks l
          where l.locktype = 'advisory'
          and l.classid = ${key1}
          and l.objid = ${key2}
          and l.objsubid = 2
          and l.granted = true
        ) as holding
      `;
      return Boolean(row?.holding);
    });

    const secondMigrator = migrateIndex(connB, schema, {
      lockTimeoutMs: 10_000,
    });

    await pollUntil(async () => {
      const [row] = await sql<{ readonly waiting: boolean }[]>`
        select exists
        (
          select 1
          from pg_catalog.pg_locks l
          where l.locktype = 'advisory'
          and l.classid = ${key1}
          and l.objid = ${key2}
          and l.objsubid = 2
          and l.granted = false
        ) as waiting
      `;
      return Boolean(row?.waiting);
    });

    releaseRowLock();
    await rowLockTask;

    const [resultA, resultB] = await Promise.all([
      firstMigrator,
      secondMigrator,
    ]);
    assert.deepEqual(resultA, {
      schema,
      fromVersion: "2",
      toVersion: "3",
      applied: [],
    });
    assert.deepEqual(resultB, {
      schema,
      fromVersion: "3",
      toVersion: "3",
      applied: [],
    });
    assert.equal(await readIndexMarker(sql, schema), SCHEMA_FORMAT_VERSION);
    assert.equal(await schemaExists(sql, schema), true);
  } finally {
    await connA`reset all`.catch(() => {});
    await connB`reset all`.catch(() => {});
    await connA.end();
    await connB.end();
    await blocker.end();
    await dropTestSchema(sql, schema);
  }
});

test("dump and restore preserves migrated index catalog, privileges, records, queue, and ledger, and restored index accepts migrateIndex", async () => {
  const schema = randomTestSchema();
  const dumpReaderRole = randomRole("sgtest_dump_reader");
  const restoredDb = `sgtest_restore_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  let restoredSql: Sql | undefined;
  try {
    await sql.unsafe(`create role "${dumpReaderRole}" login`);
    await createFormat2Index(sql, schema, {
      dimensions: 4,
      vectorType: "halfvec",
    });
    await sql`
      insert into ${sql(schema)}.record (id, content, meta, tree, name, embedding)
      values
        ( '019571e2-7c00-7000-8000-000000000021'::uuid
        , 'restored embedded document'
        , '{"restored":true}'::jsonb
        , 'docs.restore'::public.ltree
        , 'embedded'
        , '[1,0,0,0]'::public.halfvec(4)
        )
      , ( '019571e2-7c00-7000-8000-000000000022'::uuid
        , 'restored pending document'
        , '{"restored":false}'::jsonb
        , 'docs.restore'::public.ltree
        , 'pending'
        , null
        )
    `;
    await migrateIndex(sql, schema);
    await sql.unsafe(
      `revoke all on function "${schema}".get_record(uuid) from public`,
    );
    await sql.unsafe(
      `grant execute on function "${schema}".get_record(uuid) to "${dumpReaderRole}" with grant option`,
    );

    await sql.unsafe(`drop database if exists "${restoredDb}" with (force)`);
    await sql.unsafe(`create database "${restoredDb}"`);
    restoredSql = connectToDatabase(restoredDb, 2);
    await restoredSql`create extension if not exists vector with schema public`;
    await restoredSql`create extension if not exists pg_textsearch with schema public`;
    await restoredSql`create extension if not exists ltree with schema public`;

    const baseUrl = new URL(
      process.env.TEST_DATABASE_URL ??
        "postgresql://postgres@127.0.0.1:5432/postgres",
    );
    const port = Number(baseUrl.port || "5432");
    const user = decodeURIComponent(baseUrl.username || "postgres");
    const container = await resolvePostgresContainer(port);

    if (container) {
      const { stdout: dumpSql } = await execFileAsync("docker", [
        "exec",
        container,
        "pg_dump",
        "--format=plain",
        `--schema=${schema}`,
        "-U",
        user,
        "-d",
        sql.options.database,
      ]);
      await runWithStdin(
        "docker",
        [
          "exec",
          "-i",
          container,
          "psql",
          "-v",
          "ON_ERROR_STOP=1",
          "-U",
          user,
          "-d",
          restoredDb,
        ],
        dumpSql,
      );
    } else {
      const srcUrl = new URL(baseUrl);
      srcUrl.pathname = `/${sql.options.database}`;
      const dstUrl = new URL(baseUrl);
      dstUrl.pathname = `/${restoredDb}`;
      const { stdout: dumpSql } = await execFileAsync("pg_dump", [
        "--format=plain",
        `--schema=${schema}`,
        srcUrl.toString(),
      ]);
      await runWithStdin(
        "psql",
        ["-v", "ON_ERROR_STOP=1", "-d", dstUrl.toString()],
        dumpSql,
      );
    }

    const [restoredPrivileges] = await restoredSql<
      {
        readonly public_exec: boolean;
        readonly reader_exec: boolean;
        readonly reader_grant_opt: boolean;
      }[]
    >`
      select
        pg_catalog.has_function_privilege('public', ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE') as public_exec
      , pg_catalog.has_function_privilege(${dumpReaderRole}, ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE') as reader_exec
      , pg_catalog.has_function_privilege(${dumpReaderRole}, ${`${schema}.get_record(uuid)`}::pg_catalog.regprocedure, 'EXECUTE WITH GRANT OPTION') as reader_grant_opt
    `;
    assert.deepEqual(restoredPrivileges, {
      public_exec: false,
      reader_exec: true,
      reader_grant_opt: true,
    });

    assert.deepEqual(
      await schemaCatalog(restoredSql, schema),
      await schemaCatalog(sql, schema),
    );
    assert.deepEqual(
      Array.from(
        await restoredSql`
          select
            id
          , content
          , meta
          , tree::text as tree
          , name
          , embedding::text as embedding
          , content_version
          , version
          , version_hash
          , created_at
          , updated_at
          from ${restoredSql(schema)}.record
          order by id
        `,
      ),
      Array.from(
        await sql`
          select
            id
          , content
          , meta
          , tree::text as tree
          , name
          , embedding::text as embedding
          , content_version
          , version
          , version_hash
          , created_at
          , updated_at
          from ${sql(schema)}.record
          order by id
        `,
      ),
    );
    assert.deepEqual(
      Array.from(
        await restoredSql`
          select name, applied_at_version, applied_at
          from ${restoredSql(schema)}.migration
          order by name
        `,
      ),
      Array.from(
        await sql`
          select name, applied_at_version, applied_at
          from ${sql(schema)}.migration
          order by name
        `,
      ),
    );

    const remigrated = await migrateIndex(restoredSql, schema);
    assert.deepEqual(remigrated, {
      schema,
      fromVersion: "3",
      toVersion: "3",
      applied: [],
    });
    const restoredIndex = await openIndex(restoredSql, schema, {
      embedding: mockEmbeddingModel({
        "restored pending document": [0, 1, 0, 0],
      }),
    });
    const drained = await restoredIndex.processEmbeddings({ maxBatches: 1 });
    assert.equal(drained.embedded, 1);
  } finally {
    await restoredSql?.end();
    await sql
      .unsafe(`drop database if exists "${restoredDb}" with (force)`)
      .catch(() => {});
    await dropTestSchema(sql, schema);
    await sql
      .unsafe(`drop owned by "${dumpReaderRole}" cascade`)
      .catch(() => {});
    await sql.unsafe(`drop role if exists "${dumpReaderRole}"`);
  }
});
