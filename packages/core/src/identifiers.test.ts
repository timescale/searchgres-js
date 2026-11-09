import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidConfigError, TreePathError } from "./errors.ts";
import {
  assertSchemaName,
  assertTreePath,
  isValidSchemaName,
  isValidTreePath,
  MAX_IDENTIFIER_LENGTH,
} from "./identifiers.ts";

test("schema names use a predictable lowercase PostgreSQL subset", () => {
  for (const schema of ["docs", "docs_v2", "_private", "a1"]) {
    assert.equal(isValidSchemaName(schema), true, schema);
    assert.equal(assertSchemaName(schema), schema);
  }

  for (const schema of [
    "",
    "2docs",
    "Docs",
    "docs-api",
    "docs.api",
    "with space",
    "x".repeat(MAX_IDENTIFIER_LENGTH + 1),
  ]) {
    assert.equal(isValidSchemaName(schema), false, schema);
    assert.throws(
      () => assertSchemaName(schema),
      (error: unknown) =>
        error instanceof InvalidConfigError && error.issues.length > 0,
      schema,
    );
  }
});

test("tree paths are raw dotted ltree paths, including the empty root", () => {
  for (const path of [
    "",
    "docs",
    "docs.api.v2",
    "docs.auth-flow",
    "HOME.User_7",
  ]) {
    assert.equal(isValidTreePath(path), true, path);
    assert.equal(assertTreePath(path), path);
  }
});

test("tree path validation rejects normalization and pattern syntax", () => {
  for (const path of [
    "/docs/api",
    "docs/api",
    ".docs",
    "docs.",
    "docs..api",
    "docs.*",
    "docs|api",
    "docs & api",
    "docs api",
  ]) {
    assert.equal(isValidTreePath(path), false, path);
    assert.throws(
      () => assertTreePath(path),
      (error: unknown) => {
        assert.ok(error instanceof TreePathError);
        assert.equal(error.path, path);
        return true;
      },
    );
  }
});
