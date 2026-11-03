import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";
import { test } from "node:test";
import { indexDefinitions, schemaDefinitions } from "./definitions.ts";
import { indexSqlContext, renderSql } from "./template.ts";

test("definition order and span metadata match the original format-2 builders", async () => {
  const expected = JSON.parse(
    await readFile(
      new URL(
        "../test/fixtures/format-2-definition-order.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const actual = [
    ...schemaDefinitions.map(({ spanName, dbOperationName }) => ({
      phase: "schema",
      spanName,
      dbOperationName,
    })),
    ...indexDefinitions.map(({ spanName, dbOperationName }) => ({
      phase: "index",
      spanName,
      dbOperationName,
    })),
  ];
  assert.deepEqual(actual, expected);
});

test("every SQL source has exactly one manifest entry with matching embedded text", async () => {
  const directory = new URL("./sql/", import.meta.url);
  const files = (await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith(".sql"))
    .map((path) => path.split(sep).join("/"))
    .sort();
  const definitions = [...schemaDefinitions, ...indexDefinitions];
  assert.deepEqual(
    definitions.map((definition) => definition.source).sort(),
    files,
  );
  assert.equal(
    new Set(definitions.map((definition) => definition.spanName)).size,
    definitions.length,
  );
  for (const definition of definitions) {
    assert.equal(
      definition.sql,
      await readFile(new URL(definition.source, directory), "utf8"),
    );
    for (const vectorType of ["vector", "halfvec"] as const) {
      const context = indexSqlContext(
        "sgtest_manifest",
        { dimensions: 4, vectorType },
        "'english'",
      );
      const rendered = renderSql(definition.sql, context.variables);
      assert.ok(!rendered.includes("{{"), definition.source);
      assert.ok(!rendered.includes("}}"), definition.source);
    }
  }
});
