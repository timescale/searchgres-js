import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Sql } from "postgres";
import { createIndex, SCHEMA_FORMAT_VERSION } from "../src/create-index.ts";
import {
  defineMigration,
  executeMigrationFile,
  provisionMigration,
} from "../src/db/definitions.ts";
import {
  indexSqlContext,
  renderSql,
  sqlIdentifier,
  sqlLiteral,
} from "../src/db/template.ts";
import { noEmbedding } from "../src/embedding.ts";
import { openIndex } from "../src/open-index.ts";
import { postgresErrorCode } from "../src/sql/errors.ts";
import {
  connect,
  dropTestSchema,
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

test("definition fragments round-trip quotes and backslashes under either string setting", async () => {
  const value = "it's \\ SQL {{schema_ident}} 雪";
  const identifier = 'a.b"c';
  const query = renderSql(
    "select {{text_config_literal}} as {{schema_ident}}",
    {
      schema_ident: sqlIdentifier(identifier),
      text_config_literal: sqlLiteral(value),
    },
  );
  for (const setting of ["on", "off"]) {
    await sql.begin(async (tx) => {
      await tx`select pg_catalog.set_config('standard_conforming_strings', ${setting}, true)`;
      const [row] = await tx.unsafe(query);
      assert.equal(row?.[identifier], value);
    });
  }
});

test("catalog text configuration literals are escaped and not recursively templated", async () => {
  const configurationSchema = randomTestSchema();
  const schema = randomTestSchema();
  const name = "odd'\\{{schema_ident}}";
  try {
    await sql`create schema ${sql(configurationSchema)}`;
    await sql`create text search configuration ${sql(configurationSchema)}.${sql(name)} (copy = pg_catalog.simple)`;
    await createIndex(sql, schema, {
      dimensions: 4,
      bm25: { textConfig: `${configurationSchema}."${name}"` },
    });
    const index = await openIndex(sql, schema, { embedding: noEmbedding });
    const written = await index.upsert({ content: "quoted configuration" });
    assert.equal(
      (await index.search({ fulltext: "quoted" }))[0]?.id,
      written.id,
    );
  } finally {
    await dropTestSchema(sql, schema);
    await dropTestSchema(sql, configurationSchema);
  }
});

test("migration execution participates in caller rollback after a late DDL failure", async () => {
  const schema = randomTestSchema();
  const context = indexSqlContext(schema, { dimensions: 4 }, "'english'");
  try {
    let failed = false;
    try {
      await sql.begin(async (tx) => {
        await executeMigrationFile(
          tx,
          context,
          provisionMigration,
          SCHEMA_FORMAT_VERSION,
        );
        assert.equal(
          (
            await tx`select pg_catalog.to_regnamespace(${schema}) is not null as present`
          )[0]?.present,
          true,
        );
        await executeMigrationFile(
          tx,
          context,
          defineMigration(
            "incremental",
            "incremental/999_broken.sql",
            "create table {{schema_ident}}.broken (id pg_catalog.no_such_type)",
          ),
          SCHEMA_FORMAT_VERSION,
        );
      });
    } catch (error) {
      assert.equal(postgresErrorCode(error), "42704");
      failed = true;
    }
    assert.ok(failed, "the invalid definition must fail");
    assert.equal(await schemaExists(sql, schema), false);
    assert.equal((await sql`select 1 as alive`)[0]?.alive, 1);
  } finally {
    await dropTestSchema(sql, schema);
  }
});
