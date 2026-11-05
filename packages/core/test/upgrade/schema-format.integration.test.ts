import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex, SCHEMA_FORMAT_VERSION } from "../../src/create-index.ts";
import { readIndexMarker } from "../../src/db/marker.ts";
import { migrateIndex } from "../../src/migrate-index.ts";
import {
  connect,
  connectToDatabase,
  dropTestSchema,
  randomTestSchema,
} from "../support/db.ts";
import {
  SCHEMA_FORMAT_CASES,
  schemaCatalog,
} from "../support/schema-catalog.ts";
import { cleanupV032Core, createFormat2Index } from "./format-2.ts";

let sql: Sql;
before(() => {
  sql = connect();
});
after(async () => {
  await cleanupV032Core();
  await sql.end();
});

for (const { name, config } of SCHEMA_FORMAT_CASES) {
  test(`v0.3.2 format-2 index upgrades to match fresh format-3 catalog: ${name}`, async () => {
    assert.equal(SCHEMA_FORMAT_VERSION, "3");
    const upgradedSchema = randomTestSchema();
    const freshSchema = randomTestSchema();
    try {
      await createFormat2Index(sql, upgradedSchema, config);
      assert.equal(await readIndexMarker(sql, upgradedSchema), "2");

      await migrateIndex(sql, upgradedSchema);
      await createIndex(sql, freshSchema, config);

      const upgradedCatalog = await schemaCatalog(sql, upgradedSchema);
      const freshCatalog = await schemaCatalog(sql, freshSchema);
      assert.deepEqual(Object.keys(upgradedCatalog), Object.keys(freshCatalog));
      for (const section of Object.keys(freshCatalog)) {
        assert.deepEqual(
          upgradedCatalog[section],
          freshCatalog[section],
          `${name}: ${section}; upgraded format-2 catalog must match fresh format-3 catalog`,
        );
      }

      const upgradedMigrations = await sql<
        {
          readonly name: string;
          readonly applied_at_version: string;
        }[]
      >`
        select name, applied_at_version
        from ${sql(upgradedSchema)}.migration
        order by name collate "C"
      `;
      const freshMigrations = await sql<
        {
          readonly name: string;
          readonly applied_at_version: string;
        }[]
      >`
        select name, applied_at_version
        from ${sql(freshSchema)}.migration
        order by name collate "C"
      `;
      assert.deepEqual(
        upgradedMigrations.map((row) => row.name),
        freshMigrations.map((row) => row.name),
      );
      assert.deepEqual(Array.from(upgradedMigrations), [
        { name: "001_initial", applied_at_version: "2" },
      ]);
      assert.deepEqual(Array.from(freshMigrations), [
        { name: "001_initial", applied_at_version: "3" },
      ]);
    } finally {
      await dropTestSchema(sql, upgradedSchema);
      await dropTestSchema(sql, freshSchema);
    }
  });
}

test("catalog deparsing is independent of caller GUCs and leaves them unchanged", async () => {
  const schema = randomTestSchema();
  const connection = connectToDatabase(sql.options.database, 1);
  try {
    await createIndex(connection, schema, { dimensions: 4 });
    const expected = await schemaCatalog(connection, schema);
    await connection`set search_path to public, pg_catalog`;
    await connection`set timezone to 'Pacific/Auckland'`;
    await connection`set datestyle to 'SQL, DMY'`;
    await connection`set quote_all_identifiers to on`;
    await connection`set extra_float_digits to 0`;
    const settings = () => connection`
      select
        pg_catalog.current_setting('search_path') as search_path
      , pg_catalog.current_setting('timezone') as timezone
      , pg_catalog.current_setting('datestyle') as datestyle
      , pg_catalog.current_setting('quote_all_identifiers') as quote_all_identifiers
      , pg_catalog.current_setting('extra_float_digits') as extra_float_digits
    `;
    const before = Array.from(await settings());
    assert.deepEqual(await schemaCatalog(connection, schema), expected);
    assert.deepEqual(Array.from(await settings()), before);
  } finally {
    await connection`reset all`;
    await dropTestSchema(connection, schema);
    await connection.end();
  }
});

test("catalog retains exact function whitespace and detects extra helper objects", async () => {
  const schema = randomTestSchema();
  try {
    await createIndex(sql, schema, { dimensions: 4 });
    const expected = await schemaCatalog(sql, schema);
    const [routine] = await sql<{ definition: string }[]>`
      select pg_catalog.pg_get_functiondef(p.oid) as definition
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = ${schema} and p.proname = 'record_integrity'
    `;
    assert.ok(routine);
    const changed = routine.definition.replace("\nbegin", "\n  begin");
    assert.notEqual(changed, routine.definition);
    await sql.unsafe(changed);
    const changedFunction = await schemaCatalog(sql, schema);
    assert.notDeepEqual(changedFunction.functions, expected.functions);
    assert.deepEqual(changedFunction.relations, expected.relations);

    await sql`create sequence ${sql(schema)}.unexpected_helper`;
    const changedObjects = await schemaCatalog(sql, schema);
    assert.notDeepEqual(changedObjects.relations, expected.relations);
    assert.notDeepEqual(changedObjects.sequences, expected.sequences);
    assert.notDeepEqual(changedObjects.inventory, expected.inventory);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
