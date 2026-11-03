import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex, SCHEMA_FORMAT_VERSION } from "../src/create-index.ts";
import {
  connect,
  connectToDatabase,
  dropTestSchema,
  randomTestSchema,
} from "./support/db.ts";
import {
  type CatalogFixture,
  SCHEMA_FORMAT_CASES,
  schemaCatalog,
} from "./support/schema-catalog.ts";

let sql: Sql;
before(() => {
  sql = connect();
});
after(async () => {
  await sql.end();
});

for (const { name, config } of SCHEMA_FORMAT_CASES) {
  test(`format 2 catalog matches the PRE-EXTRACTION baseline: ${name}`, async () => {
    assert.equal(SCHEMA_FORMAT_VERSION, "2");
    const fixture = JSON.parse(
      await readFile(
        new URL(`./fixtures/schema-format-2/${name}.json`, import.meta.url),
        "utf8",
      ),
    ) as CatalogFixture;
    assert.deepEqual(
      fixture.config,
      config,
      "fixture must describe this input",
    );
    const schema = randomTestSchema();
    try {
      await createIndex(sql, schema, config);
      const actual = await schemaCatalog(sql, schema);
      assert.deepEqual(Object.keys(actual), Object.keys(fixture.catalog));
      for (const section of Object.keys(fixture.catalog)) {
        assert.deepEqual(
          actual[section],
          fixture.catalog[section],
          `${name}: ${section}; format 2 is immutable. Do not regenerate goldens from extracted DDL.`,
        );
      }
    } finally {
      await dropTestSchema(sql, schema);
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
      select pg_catalog.current_setting('search_path') as search_path,
             pg_catalog.current_setting('timezone') as timezone,
             pg_catalog.current_setting('datestyle') as datestyle,
             pg_catalog.current_setting('quote_all_identifiers') as quote_all_identifiers,
             pg_catalog.current_setting('extra_float_digits') as extra_float_digits
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
    // A whitespace-only source edit must remain visible. This definition comes
    // from this disposable schema, never from an executable copy of the golden.
    const changed = routine.definition.replace(
      "\n        begin",
      "\n         begin",
    );
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
