import assert from "node:assert/strict";
import { test } from "node:test";
import { InvalidInputError } from "../src/errors.ts";
import { Index } from "../src/open-index.ts";
import { noTruncation } from "../src/truncate.ts";

// A handle whose pool is never reached: every case below fails validation
// before any SQL runs, so the fake `sql` is safe.
function fakeIndex(): Index {
  return new Index({
    sql: (() => {
      throw new Error("sql should not be called for invalid input");
    }) as never,
    schema: "sgtest_validation",
    vectorType: "halfvec",
    dimensions: 4,
    vectorIndex: "hnsw",
    embedding: {} as never,
    truncate: noTruncation,
  });
}

async function rejects(options: unknown): Promise<void> {
  await assert.rejects(
    () => fakeIndex().search(options as never),
    InvalidInputError,
  );
}

test("rejects providing both semantic text and a vector", async () => {
  await rejects({ semantic: "hello", vector: [1, 0, 0, 0] });
});

test("rejects semanticThreshold without a semantic arm", async () => {
  await rejects({ fulltext: "hello", semanticThreshold: 0.5 });
});

test("rejects hybrid-only tuning on a single-arm search", async () => {
  await rejects({ semantic: "hello", candidateLimit: 20 });
  await rejects({ fulltext: "hello", k: 40 });
  await rejects({ semantic: "hello", fulltextWeight: 0.5 });
});

test("rejects cursors and order on a ranked search", async () => {
  await rejects({ fulltext: "hello", order: "asc" });
  await rejects({
    semantic: "hello",
    after: "019ce89d-f8b4-7000-8000-000000000001",
  });
  await rejects({
    vector: [1, 0, 0, 0],
    before: "019ce89d-f8b4-7000-8000-000000000001",
  });
});

test("rejects supplying both after and before", async () => {
  await rejects({
    after: "019ce89d-f8b4-7000-8000-000000000001",
    before: "019ce89d-f8b4-7000-8000-000000000002",
  });
});

test("rejects an unknown filter key", async () => {
  await rejects({ filter: { bogus: "x" } });
});

test("rejects a filter node with more than one key", async () => {
  await rejects({ filter: { tree: "docs", regexp: "x" } });
});

test("rejects and/or with fewer than two children", async () => {
  await rejects({ filter: { and: [{ tree: "docs" }] } });
});

test("rejects filter nesting past the depth cap", async () => {
  let node: unknown = { tree: "docs" };
  for (let i = 0; i < 20; i++) {
    node = { not: node };
  }
  await rejects({ filter: node });
});

test("bounds pathological filters before schema parsing", async () => {
  // Deep enough to overflow Zod's recursive parser if it ran first; the guard
  // must turn it into the typed depth error, not a RangeError.
  let deep: unknown = { tree: "docs" };
  for (let i = 0; i < 50_000; i++) {
    deep = { not: deep };
  }
  await assert.rejects(
    () => fakeIndex().search({ filter: deep } as never),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.match(error.message, /maximum depth of 16/);
      return true;
    },
  );

  // Wide rather than deep: the node cap.
  const wide = {
    and: Array.from({ length: 101 }, (_, i) => ({ tree: `t${i}` })),
  };
  await assert.rejects(
    () => fakeIndex().search({ filter: wide } as never),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.match(error.message, /maximum of 100 nodes/);
      return true;
    },
  );

  // Exactly at the depth cap the guard is silent; the malformed leaf is then
  // reported by the schema, proving Zod still ran.
  let atCap: unknown = { bogus: 1 };
  for (let i = 0; i < 15; i++) {
    atCap = { not: atCap };
  }
  await assert.rejects(
    () => fakeIndex().search({ filter: atCap } as never),
    (error: unknown) => {
      assert.ok(error instanceof InvalidInputError);
      assert.doesNotMatch(error.message, /maximum depth/);
      return true;
    },
  );
});

test("rejects a regexp filter as the only criterion", async () => {
  await rejects({ filter: { regexp: "throttl" } });
});

test("rejects a regexp filter guarded only by an OR sibling", async () => {
  await rejects({
    filter: { or: [{ tree: "docs.api" }, { regexp: "throttl" }] },
  });
});

test("rejects a regexp filter under not in a filter-only search", async () => {
  await rejects({
    filter: { and: [{ tree: "docs" }, { not: { regexp: "throttl" } }] },
  });
});

test("rejects an inverted temporal range", async () => {
  await rejects({
    filter: {
      temporalWithin: ["2026-02-01T00:00:00Z", "2026-01-01T00:00:00Z"],
    },
  });
});
