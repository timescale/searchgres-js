import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { sep } from "node:path";
import { test } from "node:test";
import { sqlLocation } from "../sql/exec.ts";
import {
  bootstrapMigrations,
  defineMigration,
  idempotentMigrations,
  incrementalMigrations,
  migrationNameFromFile,
  migrationTableMigration,
} from "./definitions.ts";
import { indexSqlContext, migrationSqlContext, renderSql } from "./template.ts";

test("migration names derive from numbered filenames and are sorted alphanumerically", () => {
  assert.equal(
    migrationNameFromFile("incremental/001_initial.sql"),
    "001_initial",
  );
  assert.equal(
    migrationNameFromFile("idempotent/004_search.sql"),
    "004_search",
  );
  for (const invalid of [
    "incremental/initial.sql",
    "incremental/01_initial.sql",
    "incremental/001-initial.sql",
    "incremental/001_Initial.sql",
    "incremental/001_initial.txt",
  ]) {
    assert.throws(() => migrationNameFromFile(invalid));
  }

  for (const [kind, group] of [
    ["bootstrap", bootstrapMigrations],
    ["incremental", incrementalMigrations],
    ["idempotent", idempotentMigrations],
  ] as const) {
    const names = group.map((migration) => migration.name);
    assert.deepEqual(
      names,
      [...names].sort((a, b) => a.localeCompare(b)),
      `${kind} migrations must be sorted by name`,
    );
    assert.equal(new Set(names).size, names.length);
    for (const migration of group) {
      assert.equal(migration.type, kind);
      assert.equal(migration.name, migrationNameFromFile(migration.file));
      assert.ok(migration.file.startsWith(`${kind}/`));
    }
  }
});

test("frozen.txt matches the released prefix of incremental migrations and allows trailing unfrozen files", async () => {
  const frozenRaw = await readFile(
    new URL("./sql/incremental/frozen.txt", import.meta.url),
    "utf8",
  );
  const frozenEntries = frozenRaw
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha256, filename] = line.trim().split(/\s+/);
      return { filename, sha256 };
    });
  assert.ok(
    frozenEntries.length <= incrementalMigrations.length,
    "frozen.txt cannot list more migrations than incrementalMigrations",
  );
  assert.deepEqual(
    incrementalMigrations.slice(0, frozenEntries.length).map((migration) => ({
      filename: migration.file.slice("incremental/".length),
      sha256: createHash("sha256").update(migration.sql).digest("hex"),
    })),
    frozenEntries,
  );
});

test("every SQL file in sql/ has one manifest entry and renders cleanly", async () => {
  const directory = new URL("./sql/", import.meta.url);
  const files = (await readdir(directory, { recursive: true }))
    .filter((path) => path.endsWith(".sql"))
    .map((path) => path.split(sep).join("/"))
    .sort();
  const migrations = [
    ...bootstrapMigrations,
    ...incrementalMigrations,
    ...idempotentMigrations,
  ];
  assert.deepEqual(migrations.map((migration) => migration.file).sort(), files);

  for (const migration of migrations) {
    assert.equal(
      migration.sql,
      await readFile(new URL(migration.file, directory), "utf8"),
    );
    for (const vectorType of ["vector", "halfvec"] as const) {
      for (const method of ["hnsw", "prism"] as const) {
        const context = indexSqlContext(
          "sgtest_manifest",
          { dimensions: 4, vectorType, vectorIndex: { method } },
          "'english'",
        );
        const rendered = renderSql(migration.sql, context.variables);
        assert.ok(!rendered.includes("{{"), migration.file);
        assert.ok(!rendered.includes("}}"), migration.file);
      }
    }
  }

  for (const migration of [migrationTableMigration, ...idempotentMigrations]) {
    for (const vectorType of ["vector", "halfvec"] as const) {
      const context = migrationSqlContext("sgtest_manifest", {
        vectorType,
        dimensions: 4,
      });
      const rendered = renderSql(migration.sql, context.variables);
      assert.ok(!rendered.includes("{{"), migration.file);
      assert.ok(!rendered.includes("}}"), migration.file);
    }
  }
});

test("sqlLocation maps 1-based PostgreSQL Unicode character positions to line and column", () => {
  const sample = "select 1;\ncreate table broken (\n  bad no_such_type\n);";
  assert.deepEqual(sqlLocation(sample, 1), { line: 1, column: 1 });
  assert.deepEqual(sqlLocation(sample, 11), { line: 2, column: 1 });
  assert.deepEqual(sqlLocation(sample, 39), { line: 3, column: 7 });
  assert.deepEqual(sqlLocation("select '😀';\nselect broken;", 13), {
    line: 2,
    column: 1,
  });
  assert.equal(sqlLocation("select '😀';", 13), undefined);
  assert.equal(sqlLocation(sample, 0), undefined);
  assert.equal(sqlLocation(sample, sample.length + 2), undefined);
  assert.equal(sqlLocation(sample, Number.NaN), undefined);
  assert.equal(
    defineMigration("idempotent", "idempotent/001_test.sql", sample).name,
    "001_test",
  );
});
