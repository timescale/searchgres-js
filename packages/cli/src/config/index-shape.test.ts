import { expect, test } from "bun:test";
import { assertConfiguredIndexShape } from "./index-shape.ts";

const configured = {
  schema: "docs",
  dimensions: 768,
  vectorType: "halfvec" as const,
  embedding: {
    provider: "openai-compatible" as const,
    model: "test-model",
  },
  truncate: { kind: "none" as const },
  worker: { interval: 1_000, batchSize: 100 },
};

test("configured index shape accepts an exact match", () => {
  expect(() =>
    assertConfiguredIndexShape(
      { schema: "docs", dimensions: 768, vectorType: "halfvec" },
      configured,
    ),
  ).not.toThrow();
});

test("configured index shape reports configured and actual storage", () => {
  expect(() =>
    assertConfiguredIndexShape(
      { schema: "docs", dimensions: 1_536, vectorType: "vector" },
      configured,
    ),
  ).toThrow(
    'Index "docs" does not match the config: configured halfvec(768), database has vector(1536)',
  );
  expect(() =>
    assertConfiguredIndexShape(
      {
        schema: "docs",
        dimensions: 768,
        vectorType: "halfvec",
        vectorIndex: "prism",
      },
      { ...configured, vectorIndex: "hnsw" },
    ),
  ).toThrow(
    'Index "docs" does not match the config: configured halfvec(768), database has halfvec(768) (hnsw vs prism)',
  );
});
