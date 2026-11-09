import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BatchTooLargeError,
  ConflictError,
  compareSchemaVersions,
  DimensionMismatchError,
  EmbeddingUnavailableError,
  ExtensionError,
  InvalidConfigError,
  InvalidIndexError,
  InvalidInputError,
  LockTimeoutError,
  NotFoundError,
  parseSchemaVersion,
  RateLimitError,
  SchemaVersionError,
  SearchgresError,
  UnsupportedServerError,
  ValidationError,
} from "./errors.ts";

test("all typed errors retain a stable code, class name, and cause", () => {
  const cause = new Error("postgres said no");
  const error = new ConflictError("record already exists", { cause });

  assert.ok(error instanceof SearchgresError);
  assert.ok(error instanceof ConflictError);
  assert.equal(error.name, "ConflictError");
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.cause, cause);
});

test("NotFoundError renders an id or a (tree, name) address", () => {
  const byId = new NotFoundError("019ce89d-f8b4-7000-8000-000000000001");
  assert.equal(
    byId.message,
    'Record "019ce89d-f8b4-7000-8000-000000000001" was not found',
  );
  const byName = new NotFoundError({ tree: "scratch", name: "nope" });
  assert.equal(
    byName.message,
    'Record with tree "scratch", name "nope" was not found',
  );
  assert.equal(byName.target, 'tree "scratch", name "nope"');
});

test("errors retain the fields callers need to recover", () => {
  const invalid = new InvalidIndexError("docs");
  assert.equal(invalid.schema, "docs");

  const version = new SchemaVersionError("docs", "2", "1");
  assert.equal(version.schemaVersion, "2");
  assert.equal(version.supportedVersion, "1");
  assert.match(version.message, /newer schema format 2/);

  const migratable = new SchemaVersionError("docs", "2", "3");
  assert.match(migratable.message, /migrateIndex/);

  const newerTen = new SchemaVersionError("docs", "10", "3");
  assert.match(newerTen.message, /newer schema format 10/);
  assert.equal(compareSchemaVersions("10", "3"), 1);
  assert.equal(compareSchemaVersions("2", "3"), -1);
  assert.equal(compareSchemaVersions("3", "3"), 0);
  for (const invalidVersion of ["", "0", "-1", "03", "2.0", "abc", "3 "]) {
    assert.equal(parseSchemaVersion(invalidVersion), null);
    assert.equal(compareSchemaVersions(invalidVersion, "3"), null);
  }

  const dimensions = new DimensionMismatchError(1536, 768);
  assert.equal(dimensions.expected, 1536);
  assert.equal(dimensions.actual, 768);
  assert.equal(dimensions.position, undefined);
  assert.doesNotMatch(dimensions.message, /at record/);

  const batchDimensions = new DimensionMismatchError(1536, 768, {
    position: 7,
  });
  assert.equal(batchDimensions.position, 7);
  assert.match(batchDimensions.message, /at record 7/);

  const server = new UnsupportedServerError(170_000, 180_000);
  assert.equal(server.serverVersionNum, 170_000);
  assert.equal(server.minimumVersionNum, 180_000);
  assert.match(server.message, /server reports 170000/);
  const unparseable = new UnsupportedServerError(Number.NaN, 180_000);
  assert.ok(Number.isNaN(unparseable.serverVersionNum));
  assert.match(unparseable.message, /did not report a parseable/);
  assert.doesNotMatch(unparseable.message, /NaN/);

  const extension = new ExtensionError("vector", "0.8.0", "too_old", {
    foundVersion: "0.7.4",
  });
  assert.equal(extension.reason, "too_old");
  assert.equal(extension.foundVersion, "0.7.4");

  const lockTimeout = new LockTimeoutError();
  assert.equal(lockTimeout.code, "LOCK_TIMEOUT");

  const batch = new BatchTooLargeError(1001, 1000);
  assert.equal(batch.size, 1001);
  assert.equal(batch.maximum, 1000);

  const rateLimit = new RateLimitError("slow down", 2500);
  assert.equal(rateLimit.retryAfterMs, 2500);

  const unavailable = new EmbeddingUnavailableError("process embeddings");
  assert.equal(unavailable.code, "EMBEDDING_UNAVAILABLE");
  assert.equal(unavailable.name, "EmbeddingUnavailableError");
  assert.equal(unavailable.operation, "process embeddings");
  assert.match(
    unavailable.message,
    /^Cannot process embeddings: .*noEmbedding/,
  );

  const config = new InvalidConfigError("invalid", {
    issues: [{ code: "custom", message: "bad value", path: ["bm25", "k1"] }],
  });
  assert.deepEqual(config.issues, [
    { code: "custom", message: "bad value", path: ["bm25", "k1"] },
  ]);
  assert.equal(Object.isFrozen(config.issues), true);
  assert.equal(Object.isFrozen(config.issues[0]?.path), true);
});

test("config and input validation errors share a base but distinct codes", () => {
  const config = new InvalidConfigError("bad config");
  const input = new InvalidInputError("bad input", {
    issues: [{ code: "42601", message: "syntax error", path: [] }],
  });
  assert.ok(config instanceof ValidationError);
  assert.ok(input instanceof ValidationError);
  assert.ok(config instanceof SearchgresError);
  assert.ok(input instanceof SearchgresError);
  assert.equal(config.code, "INVALID_CONFIG");
  assert.equal(input.code, "INVALID_INPUT");
  assert.equal(config.name, "InvalidConfigError");
  assert.equal(input.name, "InvalidInputError");
  assert.ok(!(input instanceof InvalidConfigError));
  assert.ok(!(config instanceof InvalidInputError));
  assert.deepEqual(input.issues, [
    { code: "42601", message: "syntax error", path: [] },
  ]);
});
