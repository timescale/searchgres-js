import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidConfigError } from "../errors.ts";
import {
  indexSqlContext,
  migrationSqlContext,
  renderSql,
  sqlIdentifier,
  sqlLiteral,
  sqlNumber,
  type TemplateVariables,
} from "./template.ts";

test("SQL fragments distinguish one identifier, a literal, and a number", () => {
  assert.equal(
    renderSql("{{schema_ident}}", { schema_ident: sqlIdentifier('a.b"c') }),
    '"a.b""c"',
  );
  assert.equal(
    renderSql("{{text_config_literal}}", {
      text_config_literal: sqlLiteral("it's SQL"),
    }),
    "'it''s SQL'",
  );
  assert.equal(
    renderSql("{{text_config_literal}}", {
      text_config_literal: sqlLiteral("a\\b'c"),
    }),
    "E'a\\\\b''c'",
  );
  assert.equal(
    renderSql("{{dimensions_int}}", { dimensions_int: sqlNumber(4, true) }),
    "4",
  );
  assert.equal(
    renderSql("{{bm25_k1_number}}", { bm25_k1_number: sqlNumber(1.7) }),
    "1.7",
  );
  assert.throws(() => sqlIdentifier(""));
  assert.throws(() => sqlIdentifier("nul\0name"));
  assert.throws(() => sqlLiteral("nul\0value"));
  for (const value of [NaN, Infinity, -Infinity])
    assert.throws(() => sqlNumber(value));
  for (const value of [1.5, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => sqlNumber(value, true));
});

test("SQL templates reject missing, unknown, malformed, inherited and raw values", () => {
  const vars = { schema_ident: sqlIdentifier("docs") };
  for (const sql of [
    "{{missing}}",
    "{{schema_ident",
    "schema_ident}}",
    "{{ schema_ident }}",
    "{{fn f() returns text}}",
    "{{{{schema_ident}}}}",
    "{{schema_ident}}}}",
    "{{toString}}",
    "{{__proto__}}",
    "{{constructor}}",
    "{{dimensions_int}}",
  ]) {
    assert.throws(() => renderSql(sql, vars));
  }
  assert.throws(() => renderSql("{{schema_ident}}", Object.create(vars)));
  assert.throws(() =>
    renderSql("{{schema_ident}}", {
      schema_ident: "docs",
    } as unknown as TemplateVariables),
  );
});

test("SQL substitution is single-pass and preserves all other bytes", () => {
  const vars = {
    text_config_literal: sqlLiteral("{{schema_ident}} $1 ` \\ 雪"),
  };
  const input = "-- comment\r\nselect {{text_config_literal}}, '{}'::jsonb;\n";
  assert.equal(
    renderSql(input, vars),
    "-- comment\r\nselect E'{{schema_ident}} $1 ` \\\\ 雪', '{}'::jsonb;\n",
  );
});

test("provisioning context validates the schema, shape and catalog literal", () => {
  const context = indexSqlContext("select", { dimensions: 4 }, "'english'");
  assert.equal(context.schema, "select");
  assert.equal(
    renderSql(
      "{{schema_ident}} public.{{vector_type_ident}}({{dimensions_int}}) public.{{cosine_opclass_ident}} {{bm25_index_literal}} {{text_config_literal}}",
      context.variables,
    ),
    '"select" public."halfvec"(4) public."halfvec_cosine_ops" \'select.record_content_bm25_idx\' \'english\'',
  );
  assert.equal(
    renderSql(
      "{{text_config_literal}}",
      indexSqlContext(
        "docs",
        { dimensions: 4, vectorType: "vector" },
        "E'a\\\\b''c'",
      ).variables,
    ),
    "E'a\\\\b''c'",
  );
  assert.throws(
    () => indexSqlContext("a$function$", { dimensions: 4 }, "'english'"),
    InvalidConfigError,
  );
  assert.throws(
    () => indexSqlContext("docs", { dimensions: 0 }, "'english'"),
    InvalidConfigError,
  );
  for (const literal of [
    "english",
    "'english'; select 1",
    "'unclosed",
    "'a\\b'",
    "'nul\0'",
  ]) {
    assert.throws(() => indexSqlContext("docs", { dimensions: 4 }, literal));
  }

  const migration = migrationSqlContext("docs", {
    vectorType: "vector",
    dimensions: 8,
    vectorIndex: "hnsw",
  });
  assert.equal(
    renderSql(
      "{{schema_ident}} public.{{vector_type_ident}}({{dimensions_int}}) public.{{cosine_opclass_ident}} {{bm25_index_literal}}",
      migration.variables,
    ),
    '"docs" public."vector"(8) public."vector_cosine_ops" \'docs.record_content_bm25_idx\'',
  );
  for (const creationOnly of [
    "{{text_config_literal}}",
    "{{bm25_k1_number}}",
    "{{bm25_b_number}}",
    "{{vector_index_with_clause}}",
  ]) {
    assert.throws(() => renderSql(creationOnly, migration.variables));
  }
  assert.throws(() =>
    migrationSqlContext("docs", {
      vectorType: "vector",
      dimensions: 2001,
      vectorIndex: "hnsw",
    }),
  );

  const prismContext = indexSqlContext(
    "docs",
    {
      dimensions: 4,
      vectorType: "halfvec",
      vectorIndex: { method: "prism", nlist: 32, targetPages: 4 },
    },
    "'english'",
  );
  assert.equal(
    renderSql(
      "create index {{vector_index_ident}} on {{schema_ident}}.record using {{vector_index_am_ident}} (embedding public.{{cosine_opclass_ident}}){{vector_index_with_clause}};",
      prismContext.variables,
    ),
    'create index "record_embedding_prism_idx" on "docs".record using "prism" (embedding public."vec16_cosine_ops")\nwith\n( nlist = 32\n, target_pages = 4\n);',
  );
  assert.throws(() =>
    migrationSqlContext("docs", {
      vectorType: "halfvec",
      dimensions: 1969,
      vectorIndex: "prism",
    }),
  );
});
