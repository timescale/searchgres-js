import { mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as clack from "@clack/prompts";
import {
  createIndex,
  dropIndex,
  ensureExtensions,
  migrateIndex,
  noEmbedding,
  openIndex,
} from "searchgres";
import type { Flags } from "../flags.ts";
import { createPool } from "../runtime/index.ts";
import { InputError } from "../runtime/report.ts";
import { loadConfiguredCommand, parseRuntimeConfig } from "./config.ts";
import { renderConfig } from "./config-file.ts";
import { dotenvLine, writeDotenvExample } from "./dotenv.ts";
import { assertConfiguredIndexShape } from "./index-shape.ts";

export async function provision(
  command: "init" | "migrate" | "destroy",
  flags: Flags,
): Promise<unknown> {
  if (command === "destroy" && !flags.has("yes"))
    throw new InputError("destroy requires --yes");
  const { config } = await loadConfiguredCommand(flags);
  const sql = createPool(config);
  try {
    if (command === "destroy") {
      await dropIndex(sql, config.index.schema);
      return { destroyed: config.index.schema };
    }
    if (command === "migrate") {
      return await migrateIndex(sql, config.index.schema);
    }
    const validate = async () => {
      const index = await openIndex(sql, config.index.schema, {
        embedding: noEmbedding,
      });
      assertConfiguredIndexShape(index, config.index);
    };
    if (flags.has("if-not-exists")) {
      const [row] =
        await sql`select exists (select 1 from pg_catalog.pg_namespace where nspname = ${config.index.schema}) as present`;
      if (row?.present) {
        await validate();
        return { schema: config.index.schema, created: false };
      }
    }
    try {
      await ensureExtensions(sql, { vectorIndex: config.index.vectorIndex });
      await createIndex(sql, config.index.schema, {
        dimensions: config.index.dimensions,
        vectorType: config.index.vectorType,
        vectorIndex: { method: config.index.vectorIndex },
      });
    } catch (error) {
      if (!flags.has("if-not-exists") || !hasSqlState(error, "42P06"))
        throw error;
      await validate();
      return { schema: config.index.schema, created: false };
    }
    return { schema: config.index.schema, created: true };
  } finally {
    await sql.end();
  }
}
function hasSqlState(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 8; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === code) return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function generateConfig(flags: Flags): Promise<void> {
  const values = new Map(flags);
  let databaseUrl: string | undefined;
  let apiKey: string | undefined;
  const interactive = !flags.has("schema") && process.stdin.isTTY;
  if (interactive) {
    clack.intro("Configure searchgres.js");
    const ask = async (message: string, initialValue?: string) => {
      const answer = await clack.text({
        message,
        ...(initialValue ? { initialValue } : {}),
        validate: (v) => (v.trim() ? undefined : "Required"),
      });
      if (clack.isCancel(answer))
        throw new InputError("Configuration cancelled");
      return answer;
    };
    values.set(
      "config",
      await ask(
        "Config path",
        String(values.get("config") ?? "searchgres.yaml"),
      ),
    );
    databaseUrl = await ask(
      "PostgreSQL URL",
      "postgresql://postgres@127.0.0.1:5432/postgres",
    );
    values.set("schema", await ask("Index schema", "docs"));
    values.set("embedding-model", await ask("Embedding model"));
    values.set("dimensions", await ask("Embedding dimensions"));
    const base = await clack.text({
      message: "OpenAI-compatible base URL (blank for OpenAI)",
    });
    if (clack.isCancel(base)) throw new InputError("Configuration cancelled");
    if (base.trim()) values.set("base-url", base.trim());
    const key = await clack.password({
      message: "Embedding API key (blank for local providers)",
    });
    if (clack.isCancel(key)) throw new InputError("Configuration cancelled");
    if (key) {
      apiKey = key;
      values.set("api-key-env", "SEARCHGRES_EMBEDDING_API_KEY");
    }
    const tokenizer = await clack.select({
      message: "Truncation tokenizer",
      options: [
        { value: "none", label: "None" },
        { value: "openai-cl100k-base", label: "OpenAI cl100k_base" },
        { value: "nomic-embed-text-v1.5", label: "Nomic embed text v1.5" },
        { value: "nomic-modernbert-embed-base", label: "Nomic ModernBERT" },
      ],
    });
    if (clack.isCancel(tokenizer))
      throw new InputError("Configuration cancelled");
    if (tokenizer !== "none") {
      values.set("tokenizer", tokenizer);
      values.set("max-tokens", await ask("Maximum content tokens"));
    }
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (typeof value !== "string" || !value)
      throw new InputError(`--${name} is required`);
    return value;
  };
  const path = String(
    values.get("config") ?? process.env.SEARCHGRES_CONFIG ?? "searchgres.yaml",
  );
  const databaseEnv = String(
    values.get("database-url-env") ?? "SEARCHGRES_DATABASE_URL",
  );
  const keyEnv = values.get("api-key-env") as string | undefined;
  const baseEnv = values.get("base-url-env") as string | undefined;
  if (values.has("tokenizer") !== values.has("max-tokens"))
    throw new InputError("--tokenizer and --max-tokens must be used together");
  const config = {
    version: 1,
    database: { urlEnv: databaseEnv },
    index: {
      schema: required("schema"),
      dimensions: Number(required("dimensions")),
      vectorType: values.get("vector-type") ?? "halfvec",
      ...(values.has("vector-index")
        ? { vectorIndex: values.get("vector-index") }
        : {}),
    },
    embedding: {
      provider: "openai-compatible",
      model: required("embedding-model"),
      ...(values.has("base-url") ? { baseUrl: required("base-url") } : {}),
      ...(baseEnv ? { baseUrlEnv: baseEnv } : {}),
      ...(keyEnv ? { apiKeyEnv: keyEnv } : {}),
      truncate: values.has("tokenizer")
        ? {
            kind: "tokens",
            tokenizer: required("tokenizer"),
            maxTokens: Number(required("max-tokens")),
          }
        : { kind: "none" },
    },
  };
  parseRuntimeConfig(config);
  const rendered = renderConfig(path, config);
  if (values.has("dry-run")) {
    process.stdout.write(rendered);
    return;
  }
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx", 0o600).catch((error: unknown) => {
    if ((error as { code?: string }).code === "EEXIST")
      throw new InputError(`${path} already exists; refusing to overwrite it`);
    throw error;
  });
  try {
    await file.writeFile(rendered);
  } finally {
    await file.close();
  }
  await writeDotenvExample(path, databaseEnv, keyEnv);
  if (baseEnv) {
    const example = await open(join(dirname(path), ".env.example"), "a");
    try {
      await example.writeFile(dotenvLine(baseEnv, ""));
    } finally {
      await example.close();
    }
  }
  if (databaseUrl) {
    const envPath = join(dirname(path), ".env");
    if (!(await Bun.file(envPath).exists())) {
      const contents =
        dotenvLine(databaseEnv, databaseUrl) +
        (apiKey && keyEnv ? dotenvLine(keyEnv, apiKey) : "");
      const env = await open(envPath, "wx", 0o600);
      try {
        await env.writeFile(contents);
      } finally {
        await env.close();
      }
    }
  }
  console.error(`Wrote ${path}; review it before running searchgres init`);
}
