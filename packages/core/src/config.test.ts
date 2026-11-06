import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { normalizeIndexConfig } from "./config.ts";
import { InvalidConfigError } from "./errors.ts";

test("config defaults match the extension defaults", () => {
  const config = normalizeIndexConfig({
    dimensions: 1536,
  });

  assert.deepEqual(config, {
    dimensions: 1536,
    vectorType: "halfvec",
    bm25: { textConfig: "english", k1: 1.2, b: 0.75 },
    vectorIndex: { method: "hnsw", m: 16, efConstruction: 64 },
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.bm25), true);
  assert.equal(Object.isFrozen(config.vectorIndex), true);

  // Normalized configs can be shallow-copied or re-normalized without losing validity.
  assert.deepEqual(normalizeIndexConfig({ ...config }), config);
});

test("custom values at upstream boundaries are accepted", () => {
  const low = normalizeIndexConfig({
    dimensions: 1,
    vectorType: "vector",
    bm25: { textConfig: "custom.english", k1: 0.1, b: 0 },
    vectorIndex: { method: "hnsw", m: 2, efConstruction: 4 },
  });
  assert.equal(low.bm25.k1, 0.1);
  assert.deepEqual(low.vectorIndex, {
    method: "hnsw",
    m: 2,
    efConstruction: 4,
  });

  const high = normalizeIndexConfig({
    dimensions: 4000,
    vectorType: "halfvec",
    bm25: { k1: 10, b: 1 },
    vectorIndex: { method: "hnsw", m: 100, efConstruction: 1000 },
  });
  assert.equal(high.dimensions, 4000);
  assert.deepEqual(high.vectorIndex, {
    method: "hnsw",
    m: 100,
    efConstruction: 1000,
  });

  const prismDefault = normalizeIndexConfig({
    dimensions: 1968,
    vectorType: "halfvec",
    vectorIndex: { method: "prism" },
  });
  assert.deepEqual(prismDefault.vectorIndex, { method: "prism" });

  const prismCustom = normalizeIndexConfig({
    dimensions: 1968,
    vectorType: "vector",
    vectorIndex: { method: "prism", nlist: 1024, targetPages: 4 },
  });
  assert.deepEqual(prismCustom.vectorIndex, {
    method: "prism",
    nlist: 1024,
    targetPages: 4,
  });
});

test("vector and halfvec enforce their HNSW and PRISM dimension ceilings", () => {
  assertInvalid(
    {
      dimensions: 2001,
      vectorType: "vector",
    },
    "dimensions",
    /between 1 and 2000/,
  );
  assertInvalid(
    {
      dimensions: 4001,
      vectorType: "halfvec",
    },
    "dimensions",
    /between 1 and 4000/,
  );
  assertInvalid(
    {
      dimensions: 1969,
      vectorType: "halfvec",
      vectorIndex: { method: "prism" },
    },
    "dimensions",
    /between 1 and 1968 for prism/,
  );
});

test("numeric storage parameters enforce upstream ranges and integer kinds", () => {
  for (const [override, path] of [
    [{ bm25: { k1: 0.09 } }, "bm25.k1"],
    [{ bm25: { b: 1.01 } }, "bm25.b"],
    [{ vectorIndex: { method: "hnsw", m: 1 } }, "vectorIndex.m"],
    [
      { vectorIndex: { method: "hnsw", efConstruction: 1001 } },
      "vectorIndex.efConstruction",
    ],
    [{ vectorIndex: { method: "hnsw", m: 16.5 } }, "vectorIndex.m"],
    [{ vectorIndex: { method: "prism", nlist: 0 } }, "vectorIndex.nlist"],
    [
      { vectorIndex: { method: "prism", targetPages: 65 } },
      "vectorIndex.targetPages",
    ],
  ] as const) {
    assertInvalid(
      {
        dimensions: 1536,
        ...override,
      },
      path,
    );
  }
});

test("text config names reject ambiguous strings", () => {
  assertInvalid(
    {
      dimensions: 1536,
      bm25: { textConfig: " english " },
    },
    "bm25.textConfig",
    /surrounding whitespace/,
  );
});

test("runtime input rejects explicit null instead of silently defaulting it", () => {
  for (const override of [
    { bm25: null },
    { vectorIndex: null },
    { bm25: { k1: null } },
    { bm25: { b: null } },
    { bm25: { textConfig: null } },
    { vectorIndex: { method: "hnsw", m: null } },
    { vectorIndex: { method: "hnsw", efConstruction: null } },
  ]) {
    assert.throws(
      () =>
        normalizeIndexConfig({
          dimensions: 1536,
          ...override,
        } as never),
      InvalidConfigError,
    );
  }
});

test("unknown keys are rejected rather than silently discarded", () => {
  assertInvalid(
    {
      dimensions: 1536,
      surprise: true,
    },
    "",
    /unrecognized key/i,
  );
});

function assertInvalid(
  input: unknown,
  expectedPath: string,
  messagePattern?: RegExp,
): void {
  assert.throws(
    // Public TypeScript callers get `IndexConfig`; the `unknown` cast exercises
    // the runtime boundary used by plain JavaScript callers.
    () => normalizeIndexConfig(input as never),
    (error: unknown) => {
      assert.ok(error instanceof InvalidConfigError);
      assert.ok(error.cause instanceof z.ZodError);
      const issue = error.issues.find(
        (candidate) => candidate.path.join(".") === expectedPath,
      );
      assert.ok(issue, `expected an issue at ${expectedPath}`);
      if (messagePattern) {
        assert.match(issue.message, messagePattern);
      }
      return true;
    },
  );
}
