import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSON5, YAML } from "bun";
import { flagsFromOptions } from "../flags.ts";
import { loadConfiguredCommand, parseRuntimeConfig } from "./config.ts";
import { renderConfig } from "./config-file.ts";

const minimal = {
  version: 1,
  database: { urlEnv: "SEARCHGRES_TEST_DATABASE" },
  index: { schema: "docs", dimensions: 768, vectorType: "halfvec" },
  embedding: { provider: "openai-compatible", model: "local-model" },
};
test("runtime config defaults, local auth, and exact tokenizer variants", () => {
  const config = parseRuntimeConfig(minimal);
  expect(config.index.vectorIndex).toBe("hnsw");
  expect(
    parseRuntimeConfig({
      ...minimal,
      index: { ...minimal.index, vectorIndex: "prism" },
    }).index.vectorIndex,
  ).toBe("prism");
  expect(config.worker.count).toBe(1);
  expect(config.database.pool.max).toBe(10);
  expect(config.embedding.apiKeyEnv).toBeUndefined();
  expect(config.embedding.requestTimeout).toBe(30000);
  expect(config.embedding.truncate.kind).toBe("none");
  for (const tokenizer of [
    "openai-cl100k-base",
    "nomic-embed-text-v1.5",
    "nomic-modernbert-embed-base",
  ]) {
    expect(
      parseRuntimeConfig({
        ...minimal,
        embedding: {
          ...minimal.embedding,
          truncate: { kind: "tokens", tokenizer, maxTokens: 10, threads: 0 },
        },
      }).embedding.truncate.kind,
    ).toBe("tokens");
  }
});
test("strict configuration rejects removed and conflicting options", () => {
  for (const value of [
    { ...minimal, server: {} },
    { ...minimal, embedding: { provider: "none" } },
    {
      ...minimal,
      embedding: {
        ...minimal.embedding,
        baseUrl: "http://localhost/v1",
        baseUrlEnv: "BASE",
      },
    },
    { ...minimal, worker: { interval: "0s" } },
    { ...minimal, worker: { count: 65 } },
    {
      ...minimal,
      embedding: {
        ...minimal.embedding,
        requestTimeout: "99999999999999999999d",
      },
    },
    { ...minimal, index: { ...minimal.index, dimensions: 4001 } },
    {
      ...minimal,
      index: { ...minimal.index, vectorIndex: "prism", dimensions: 1969 },
    },
  ])
    expect(() => parseRuntimeConfig(value)).toThrow();
});
test("config writer round trips YAML and JSON5", () => {
  expect(
    parseRuntimeConfig(YAML.parse(renderConfig("config.yaml", minimal))),
  ).toEqual(parseRuntimeConfig(minimal));
  expect(
    parseRuntimeConfig(JSON5.parse(renderConfig("config.json5", minimal))),
  ).toEqual(parseRuntimeConfig(minimal));
});
test("config discovery, dotenv precedence, explicit missing file and --no-env-file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "searchgres-config-test-"));
  const old = process.env.SEARCHGRES_CONFIG;
  const prior = process.env.SEARCHGRES_TEST_DATABASE;
  try {
    const path = join(dir, "searchgres.yaml");
    await Bun.write(path, renderConfig(path, minimal));
    await Bun.write(join(dir, ".env"), "SEARCHGRES_TEST_DATABASE=from-file\n");
    process.env.SEARCHGRES_CONFIG = path;
    process.env.SEARCHGRES_TEST_DATABASE = "existing";
    expect((await loadConfiguredCommand(new Map())).configPath).toBe(path);
    expect(process.env.SEARCHGRES_TEST_DATABASE).toBe("existing");
    delete process.env.SEARCHGRES_TEST_DATABASE;
    await loadConfiguredCommand(flagsFromOptions({ envFile: false }));
    expect(process.env.SEARCHGRES_TEST_DATABASE).toBeUndefined();
    await loadConfiguredCommand(new Map());
    expect(String(process.env.SEARCHGRES_TEST_DATABASE)).toBe("from-file");
    await expect(
      loadConfiguredCommand(new Map([["env-file", join(dir, "missing")]])),
    ).rejects.toThrow();
  } finally {
    if (old === undefined) delete process.env.SEARCHGRES_CONFIG;
    else process.env.SEARCHGRES_CONFIG = old;
    if (prior === undefined) delete process.env.SEARCHGRES_TEST_DATABASE;
    else process.env.SEARCHGRES_TEST_DATABASE = prior;
    await rm(dir, { recursive: true, force: true });
  }
});
