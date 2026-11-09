import { dirname, join, resolve } from "node:path";
import { JSON5, YAML } from "bun";
import { InvalidConfigError } from "searchgres";
import { z } from "zod";
import { loadDotenv } from "./dotenv.ts";

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
export function duration(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match)
    throw new Error("expected an integer duration with ms, s, m, h, or d");
  const factors: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60000,
    h: 3600000,
    d: 86400000,
  };
  const result = Number(match[1]) * (factors[match[2] ?? ""] ?? 0);
  if (!Number.isSafeInteger(result)) throw new Error("duration is too large");
  return result;
}
const durationSchema = z
  .string()
  .regex(/^\d+(ms|s|m|h|d)$/)
  .transform((v, ctx) => {
    try {
      return duration(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid duration" });
      return z.NEVER;
    }
  });
const positiveDuration = durationSchema.refine(
  (n) => n > 0,
  "duration must be positive",
);
const httpUrl = z.url({ protocol: /^https?$/ });
export const runtimeConfigSchema = z.strictObject({
  version: z.literal(1),
  database: z.strictObject({
    urlEnv: envName,
    pool: z
      .strictObject({
        max: z.number().int().min(1).max(1000).prefault(10),
        idleReap: durationSchema.prefault("5m"),
        maxLifetime: durationSchema.prefault("0s"),
        connectTimeout: positiveDuration.prefault("30s"),
      })
      .prefault({}),
    session: z
      .strictObject({
        statementTimeout: positiveDuration.prefault("30s"),
        lockTimeout: positiveDuration.prefault("5s"),
        transactionTimeout: positiveDuration.prefault("35s"),
        idleInTransactionSessionTimeout: positiveDuration.prefault("35s"),
      })
      .prefault({}),
  }),
  index: z
    .strictObject({
      schema: z.string().min(1),
      dimensions: z.number().int().positive(),
      vectorType: z.enum(["vector", "halfvec"]),
      // "prism" (pg_vectorsearch) is experimental until pg_vectorsearch is GA.
      vectorIndex: z.enum(["hnsw", "prism"]).prefault("hnsw"),
    })
    .superRefine((i, ctx) => {
      const limit =
        i.vectorIndex === "prism"
          ? 1968
          : i.vectorType === "vector"
            ? 2000
            : 4000;
      if (i.dimensions <= limit) return;
      // The prism limit is the same for both vector types.
      const method =
        i.vectorIndex === "prism" ? "prism" : `hnsw ${i.vectorType}`;
      ctx.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: `dimensions ${i.dimensions} exceed the ${method} limit of ${limit}`,
      });
    }),
  embedding: z
    .strictObject({
      provider: z.literal("openai-compatible"),
      model: z.string().min(1),
      baseUrl: httpUrl.optional(),
      baseUrlEnv: envName.optional(),
      apiKeyEnv: envName.optional(),
      requestTimeout: positiveDuration.prefault("30s"),
      // Literal text put before record content and query text for embedding.
      documentPrefix: z.string().prefault(""),
      queryPrefix: z.string().prefault(""),
      truncate: z
        .discriminatedUnion("kind", [
          z.strictObject({ kind: z.literal("none") }),
          z.strictObject({
            kind: z.literal("characters"),
            max: z.number().int().positive(),
          }),
          z.strictObject({
            kind: z.literal("bytes"),
            max: z.number().int().positive(),
          }),
          z.strictObject({
            kind: z.literal("tokens"),
            tokenizer: z.enum([
              "openai-cl100k-base",
              "nomic-embed-text-v1.5",
              "nomic-modernbert-embed-base",
            ]),
            maxTokens: z.number().int().positive(),
            threads: z.number().int().min(0).max(64).optional(),
          }),
        ])
        .prefault({ kind: "none" }),
    })
    .refine(
      (e) => !(e.baseUrl && e.baseUrlEnv),
      "baseUrl and baseUrlEnv are mutually exclusive",
    ),
  worker: z
    .strictObject({
      count: z.number().int().min(0).max(64).prefault(1),
      interval: positiveDuration.prefault("1s"),
      batchSize: z.number().int().min(1).max(1000).prefault(100),
    })
    .prefault({}),
});
export type RuntimeConfig = z.output<typeof runtimeConfigSchema>;
export function parseRuntimeConfig(input: unknown): RuntimeConfig {
  const result = runtimeConfigSchema.safeParse(input);
  if (!result.success)
    throw new InvalidConfigError(
      "Invalid searchgres.js configuration; check field names and values",
      {
        cause: result.error,
        issues: result.error.issues.map((issue) => ({
          code: issue.code,
          message: issue.message,
          path: issue.path.map(String),
        })),
      },
    );
  return result.data;
}
export async function loadRuntimeConfig(path: string): Promise<RuntimeConfig> {
  try {
    const source = await Bun.file(path).text();
    const parsed = /\.ya?ml$/i.test(path)
      ? YAML.parse(source)
      : /\.json5$/i.test(path)
        ? JSON5.parse(source)
        : undefined;
    if (parsed === undefined) throw new Error("config must be YAML or JSON5");
    return parseRuntimeConfig(parsed);
  } catch (error) {
    if (error instanceof InvalidConfigError) throw error;
    throw new InvalidConfigError(
      "Cannot read configuration; expected an accessible YAML or JSON5 file",
      { cause: error },
    );
  }
}
export function readRequiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new InvalidConfigError(
      `Required environment variable ${name} is not set`,
    );
  return value;
}
export async function loadConfiguredCommand(
  flags: ReadonlyMap<string, string | boolean>,
): Promise<{ configPath: string; config: RuntimeConfig }> {
  if (flags.has("env-file") && flags.has("no-env-file"))
    throw new InvalidConfigError("--env-file and --no-env-file conflict");
  const configPath = resolve(
    String(
      flags.get("config") ?? process.env.SEARCHGRES_CONFIG ?? "searchgres.yaml",
    ),
  );
  if (!flags.has("no-env-file")) {
    const explicit = flags.get("env-file");
    const envPath = explicit
      ? resolve(String(explicit))
      : join(dirname(configPath), ".env");
    if (explicit && !(await Bun.file(envPath).exists()))
      throw new InvalidConfigError("Explicit environment file does not exist");
    try {
      await loadDotenv(envPath);
    } catch (error) {
      throw new InvalidConfigError("Cannot load environment file", {
        cause: error,
      });
    }
  }
  return { configPath, config: await loadRuntimeConfig(configPath) };
}
