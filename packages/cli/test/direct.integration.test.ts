import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { JSON5 } from "bun";
import postgres from "postgres";
import { parseRuntimeConfig } from "../src/config/config.ts";
import { openRuntime } from "../src/runtime/index.ts";

const binary = resolve(import.meta.dir, "../../../dist/searchgres");
const databaseUrl =
  process.env.TEST_DATABASE_URL ??
  "postgresql://postgres@127.0.0.1:5432/postgres";
const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
const schema = `cli_${Date.now()}`;
let dir: string;
let path: string;
let provider: ReturnType<typeof Bun.serve>;
let fail = false;
let calls = 0;
let contentCalls = 0;
const env = () => ({
  ...process.env,
  SEARCHGRES_TEST_DB: databaseUrl,
  SEARCHGRES_TEST_PROVIDER: `${provider.url.toString().replace(/\/$/, "")}/v1`,
});
const config = () => ({
  version: 1,
  database: { urlEnv: "SEARCHGRES_TEST_DB" },
  index: { schema, dimensions: 4, vectorType: "halfvec" },
  embedding: {
    provider: "openai-compatible",
    model: "test-model",
    baseUrlEnv: "SEARCHGRES_TEST_PROVIDER",
    requestTimeout: "5s",
    truncate: {
      kind: "tokens",
      tokenizer: "nomic-embed-text-v1.5",
      maxTokens: 100,
      threads: 1,
    },
  },
  worker: { count: 1, interval: "100ms", batchSize: 10 },
});
async function cli(args: string[], expected = 0) {
  const child = Bun.spawn(
    [binary, "--config", path, "--no-env-file", "--json", ...args],
    { env: env(), stdout: "pipe", stderr: "pipe" },
  );
  const [status, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(status, `${args.join(" ")}: ${err}`).toBe(expected);
  return {
    out,
    err,
    value: out.trim()
      ? JSON.parse(JSON.stringify(JSON5.parse(out)))
      : undefined,
  };
}
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "searchgres-direct-"));
  path = join(dir, "config.json5");
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/embeddings")
        return new Response("not found", { status: 404 });
      calls++;
      const body = (await request.json()) as { input: string | string[] };
      const texts = typeof body.input === "string" ? [body.input] : body.input;
      contentCalls += texts.length;
      if (fail)
        return Response.json(
          {
            error: {
              message: "secret-bearing-provider-message",
              type: "invalid_request_error",
            },
          },
          { status: 400 },
        );
      return Response.json({
        object: "list",
        model: "test-model",
        usage: { prompt_tokens: 1, total_tokens: 1 },
        data: texts.map((text, index) => ({
          object: "embedding",
          index,
          embedding: text.includes("cat") ? [0, 1, 0, 0] : [1, 0, 0, 0],
        })),
      });
    },
  });
  await Bun.write(path, JSON.stringify(config()));
  await cli(["init"]);
}, 30000);
afterAll(async () => {
  await sql.unsafe(`drop schema if exists "${schema}" cascade`);
  await sql.end();
  provider?.stop(true);
  if (dir) await rm(dir, { recursive: true, force: true });
});

test("provisioning is strict and provider-free; config generation is offline", async () => {
  expect(calls).toBe(0);
  expect((await cli(["init", "--if-not-exists"])).value.created).toBe(false);
  // Simulate an unmigrated format-2 index (version 2, no migration table):
  // operational CLI commands must refuse it until `searchgres migrate` runs.
  await sql.unsafe(`drop table "${schema}".migration`);
  await sql.unsafe(
    `alter table "${schema}".version alter column version type text using version::text`,
  );
  await sql.unsafe(`update "${schema}".version set version = '2'`);
  const beforeMigrate = await cli(["info"], 1);
  expect(beforeMigrate.err).toContain("SCHEMA_VERSION");

  const migrated = (await cli(["migrate"])).value;
  expect(migrated).toEqual({
    schema,
    fromVersion: "2",
    toVersion: "3",
    applied: [],
  });
  // Repeating `searchgres migrate` at version 3 is a safe idempotent refresh.
  expect((await cli(["migrate"])).value).toEqual({
    schema,
    fromVersion: "3",
    toVersion: "3",
    applied: [],
  });
  expect(calls).toBe(0);
  const mismatch = join(dir, "mismatch.json5");
  await Bun.write(
    mismatch,
    JSON.stringify({
      ...config(),
      index: { schema, dimensions: 3, vectorType: "halfvec" },
    }),
  );
  await cli(["--config", mismatch, "init", "--if-not-exists"], 1);
  const generated = await cli([
    "config",
    "--schema",
    "offline",
    "--dimensions",
    "4",
    "--vector-index",
    "prism",
    "--embedding-model",
    "test",
    "--dry-run",
  ]);
  expect(generated.value.index.schema).toBe("offline");
  expect(generated.value.index.vectorIndex).toBe("prism");
  expect((await cli(["vector-index", "stats"])).value).toMatchObject({
    method: "hnsw",
    indexName: "record_embedding_hnsw_idx",
    prism: null,
  });
  expect(
    (await cli(["vector-index", "reindex", "--concurrently"])).value,
  ).toMatchObject({
    method: "hnsw",
    indexName: "record_embedding_hnsw_idx",
    prism: null,
  });
  expect(calls).toBe(0);
});

test("direct CRUD, filters, trees, import/export, projection and temporal round trip", async () => {
  const created = (
    await cli([
      "create",
      "--content",
      "Postgres database indexing",
      "--tree",
      "docs.db",
      "--name",
      "intro",
      "--temporal",
      "2026-01-01T00:00:00Z",
    ])
  ).value;
  const id = created.record.id;
  expect(typeof created.record.createdAt).toBe("string");
  expect(created.record.hasEmbedding).toBe(false);
  expect((await cli(["get", "docs.db", "intro"])).value.record.id).toBe(id);
  await cli(
    [
      "create",
      "--content",
      "duplicate",
      "--tree",
      "docs.db",
      "--name",
      "intro",
    ],
    2,
  );
  const updated = (
    await cli([
      "update",
      id,
      "--version-hash",
      created.record.versionHash,
      "--meta",
      '{"kind":"guide"}',
    ])
  ).value.record;
  await cli(
    [
      "update",
      id,
      "--version-hash",
      created.record.versionHash,
      "--content",
      "stale",
    ],
    2,
  );
  // Output presents temporal in its input shape, and a missing id is a
  // request error (exit 2) that names only the caller-supplied target.
  expect(created.record.temporal).toEqual(["2026-01-01T00:00:00.000Z"]);
  expect(
    (await cli(["get", "docs.db", "intro"])).value.record.temporal,
  ).toEqual(["2026-01-01T00:00:00.000Z"]);
  const missing = await cli(["get", "01900000-0000-7000-8000-00000000dead"], 2);
  expect(missing.err).toContain("NOT_FOUND");
  expect(missing.err).toContain("00000000dead");
  expect(updated.meta.kind).toBe("guide");
  const found = (
    await cli([
      "search",
      "--filter",
      '(and (tree docs) (meta {"kind":"guide"}))',
      "--select",
      "id,content:8",
    ])
  ).value;
  expect(found.results[0].id).toBe(id);
  expect(found.results[0].content).toBe("Postgres");
  expect((await cli(["count", "--tree", "docs"])).value.count).toBe(1);
  expect((await cli(["tree", "docs"])).value.entries.length).toBeGreaterThan(0);
  expect(
    (await cli(["list", "--lquery", "docs.*"])).value.entries.length,
  ).toBeGreaterThan(0);
  await cli(["copy", "docs", "copied"]);
  await cli(["move", "copied", "moved"]);
  await cli(["delete", "--tree", "moved", "--dry-run"]);
  await cli(["delete", "--tree", "moved", "--yes"]);
  const exported = join(dir, "records.ndjson");
  // Export has its own format, not global --json.
  const child = Bun.spawn(
    [
      binary,
      "--config",
      path,
      "--no-env-file",
      "export",
      exported,
      "--tree",
      "docs",
    ],
    { env: env(), stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  expect(JSON.parse((await Bun.file(exported).text()).trim()).temporal).toEqual(
    ["2026-01-01T00:00:00.000Z"],
  );
  await cli(["delete", id]);
  expect((await cli(["import", exported])).value.inserted).toBe(1);
  expect(calls).toBe(0);
}, 30000);

test("bounded compiled worker uses embedded tokenizer assets and supports all search arms", async () => {
  const result = (await cli(["embeddings", "process", "--max-batches", "1"]))
    .value;
  expect(result.embedded).toBeGreaterThan(0);
  expect(contentCalls).toBeGreaterThan(0);
  expect(
    (await cli(["search", "--semantic", "database"])).value.results.length,
  ).toBeGreaterThan(0);
  expect(
    (await cli(["search", "--fulltext", "database"])).value.results.length,
  ).toBeGreaterThan(0);
  expect(
    (await cli(["search", "--semantic", "database", "--fulltext", "database"]))
      .value.results.length,
  ).toBeGreaterThan(0);
  expect((await cli(["embeddings", "status"])).value).toEqual({
    pending: {
      total: 0,
      claimable: 0,
      deferred: 0,
      oldestAt: null,
    },
    failed: { terminal: 0 },
  });
}, 30000);

async function connectMcp(args: string[]) {
  const transport = new StdioClientTransport({
    command: binary,
    args: ["mcp", "--config", path, "--no-env-file", ...args],
    env: Object.fromEntries(
      Object.entries(env()).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    stderr: "pipe",
  });
  const client = new Client({ name: "direct-test", version: "1" });
  await client.connect(transport);
  return { client, transport };
}
async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({
    name: `searchgres_${name}`,
    arguments: args,
  });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const content = result.content as { type: string; text: string }[];
  return JSON.parse(content[0]!.text);
}
test("all twelve MCP tools use the direct database; default worker, readonly, zero and multiple workers", async () => {
  const { client } = await connectMcp([]);
  try {
    expect((await client.listTools()).tools).toHaveLength(12);
    expect((await tool(client, "info")).embedding.workerCount).toBe(1);
    const record = (
      await tool(client, "create", {
        record: { content: "MCP record", tree: "mcp", name: "first" },
      })
    ).result;
    await tool(client, "create_many", {
      records: [
        { content: "second", tree: "mcp" },
        { content: "third", tree: "mcp" },
      ],
    });
    const fetched = (await tool(client, "get", { id: record.id })).record;
    await tool(client, "update", {
      id: record.id,
      priorVersionHash: fetched.versionHash,
      patch: { meta: { source: "mcp" }, name: null },
    });
    expect(
      (
        await tool(client, "search", {
          filter: { tree: "mcp" },
          select: ["id", "createdAt"],
        })
      ).results.length,
    ).toBe(3);
    await tool(client, "tree", { tree: "mcp" });
    expect(
      (await tool(client, "count", { selector: { tree: "mcp" } })).count,
    ).toBe(3);
    await tool(client, "copy_tree", {
      source: "mcp",
      destination: "mcp_copy",
      dryRun: false,
    });
    await tool(client, "move_tree", {
      source: "mcp_copy",
      destination: "mcp_moved",
      dryRun: false,
    });
    await tool(client, "delete_tree", { tree: "mcp_moved", dryRun: false });
    await tool(client, "delete", { id: record.id });
  } finally {
    await client.close();
  }
  for (const [args, count, tools] of [
    [["--read-only", "--workers", "2"], 0, 5],
    [["--workers", "0"], 0, 12],
    [["--workers", "2"], 2, 12],
  ] as const) {
    const { client } = await connectMcp([...args]);
    try {
      expect((await client.listTools()).tools).toHaveLength(tools);
      expect((await tool(client, "info")).embedding.workerCount).toBe(count);
    } finally {
      await client.close();
    }
  }
}, 30000);

test("non-generating operations do not resolve provider credentials", async () => {
  process.env.SEARCHGRES_TEST_DB = databaseUrl;
  process.env.SEARCHGRES_TEST_PROVIDER = env().SEARCHGRES_TEST_PROVIDER;
  const missingKey = "SEARCHGRES_TEST_MISSING_KEY";
  delete process.env[missingKey];
  const authored = config();
  const runtime = await openRuntime(
    parseRuntimeConfig({
      ...authored,
      embedding: { ...authored.embedding, apiKeyEnv: missingKey },
    }),
  );
  try {
    await runtime.index.search({ fulltext: "database" });
    await runtime.info();
    expect(() => runtime.startEmbeddingWorkers(1)).toThrow(missingKey);
  } finally {
    await runtime.close();
  }
});

test("runtime close awaits foreground work and prevents further admission", async () => {
  process.env.SEARCHGRES_TEST_DB = databaseUrl;
  process.env.SEARCHGRES_TEST_PROVIDER = env().SEARCHGRES_TEST_PROVIDER;
  const runtime = await openRuntime(parseRuntimeConfig(config()));
  let release: () => void = () => {};
  const work = runtime.run(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return runtime.index.search({ semantic: "database" });
  });
  await Bun.sleep(10);
  let closed = false;
  const closing = runtime.close().then(() => {
    closed = true;
  });
  await Bun.sleep(20);
  expect(closed).toBe(false);
  await expect(runtime.run(async () => 1)).rejects.toThrow("closing");
  release();
  await work;
  await closing;
  await runtime.close();
});

test("pass failure is nonzero, reported safely, and queue APIs retry explicit IDs", async () => {
  fail = true;
  await cli(["create", "--content", "fail me", "--tree", "errors"]);
  const result = await cli(["embeddings", "process", "--max-batches", "1"], 1);
  expect(result.value.failed).toBeGreaterThan(0);
  expect(result.err).not.toContain("secret-bearing-provider-message");
  // Advance attempts/visibility only as a test fixture; the binary uses no queue SQL.
  await sql.unsafe(
    `update "${schema}".embedding_queue set attempts = 3, visible_at = now() where outcome is null`,
  );
  fail = false;
  await cli(["embeddings", "process", "--max-batches", "1"]);
  const failures = (await cli(["embeddings", "failures"])).value.failures;
  expect(failures.length).toBeGreaterThan(0);
  expect(JSON.stringify(failures)).not.toContain(
    "secret-bearing-provider-message",
  );
  expect(typeof failures[0].queueId).toBe("string");
  await cli(["embeddings", "retry", "--all"], 2);
  expect(
    (await cli(["embeddings", "retry", "--all", "--yes"])).value.retried,
  ).toBeGreaterThan(0);
  await cli(["embeddings", "process"]);
  await cli(["embeddings", "prune", "--older-than", "1d", "--yes"]);
  await cli(["embeddings", "prune", "--older-than", "1d", "--dry-run"], 2);
}, 30000);

test("destroy requires confirmation and operates on the configured index only", async () => {
  await cli(["destroy"], 2);
  await cli(["destroy", "--yes", "--schema", "public"], 2);
  expect((await cli(["destroy", "--yes"])).value.destroyed).toBe(schema);
});
