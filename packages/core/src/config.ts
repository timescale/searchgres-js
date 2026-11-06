import { z } from "zod";
import { InvalidConfigError } from "./errors.ts";
import { toValidationIssue } from "./validation.ts";

export const DEFAULT_VECTOR_TYPE = "halfvec" as const;
export const DEFAULT_VECTOR_INDEX_METHOD = "hnsw" as const;
export const DEFAULT_BM25_CONFIG = Object.freeze({
  textConfig: "english",
  k1: 1.2,
  b: 0.75,
});
export const DEFAULT_HNSW_CONFIG = Object.freeze({
  m: 16,
  efConstruction: 64,
});
export const DEFAULT_VECTOR_INDEX_CONFIG = Object.freeze({
  method: DEFAULT_VECTOR_INDEX_METHOD,
  m: DEFAULT_HNSW_CONFIG.m,
  efConstruction: DEFAULT_HNSW_CONFIG.efConstruction,
});

export const MAX_PRISM_DIMENSIONS = 1968;

export const MAX_VECTOR_DIMENSIONS = Object.freeze({
  // These are pgvector's HNSW limits, not the wider limits of the storage
  // types themselves.
  vector: 2000,
  halfvec: 4000,
});

const trimmedNonEmptyString = z
  .string()
  .min(1, "must be a non-empty string")
  .refine(
    (value) => value === value.trim(),
    "must not have surrounding whitespace",
  )
  .refine((value) => !value.includes("\0"), "must not contain NUL bytes");

const bm25Schema = z
  .object({
    textConfig: trimmedNonEmptyString.default(DEFAULT_BM25_CONFIG.textConfig),
    k1: z.number().min(0.1).max(10).default(DEFAULT_BM25_CONFIG.k1),
    b: z.number().min(0).max(1).default(DEFAULT_BM25_CONFIG.b),
  })
  .strict()
  .default(DEFAULT_BM25_CONFIG);

const hnswSchema = z
  .object({
    m: z.number().int().min(2).max(100).default(DEFAULT_HNSW_CONFIG.m),
    efConstruction: z
      .number()
      .int()
      .min(4)
      .max(1000)
      .default(DEFAULT_HNSW_CONFIG.efConstruction),
  })
  .strict();

const hnswVectorIndexSchema = z
  .object({
    method: z.literal("hnsw"),
    m: z.number().int().min(2).max(100).default(DEFAULT_HNSW_CONFIG.m),
    efConstruction: z
      .number()
      .int()
      .min(4)
      .max(1000)
      .default(DEFAULT_HNSW_CONFIG.efConstruction),
  })
  .strict();

const prismVectorIndexSchema = z
  .object({
    method: z.literal("prism"),
    nlist: z.number().int().min(1).max(2_000_000).optional(),
    targetPages: z.number().int().min(1).max(64).optional(),
  })
  .strict();

const vectorIndexSchema = z.discriminatedUnion("method", [
  hnswVectorIndexSchema,
  prismVectorIndexSchema,
]);

const indexConfigSchema = z
  .object({
    dimensions: z.number().int().positive(),
    vectorType: z.enum(["vector", "halfvec"]).default(DEFAULT_VECTOR_TYPE),
    bm25: bm25Schema,
    hnsw: hnswSchema.optional(),
    vectorIndex: vectorIndexSchema.optional(),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.hnsw !== undefined && config.vectorIndex !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["vectorIndex"],
        message: "cannot specify both hnsw and vectorIndex",
      });
    }
    const method = config.vectorIndex?.method ?? "hnsw";
    if (method === "prism") {
      if (config.dimensions > MAX_PRISM_DIMENSIONS) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `must be between 1 and ${MAX_PRISM_DIMENSIONS} for prism`,
        });
      }
    } else {
      const maximum = MAX_VECTOR_DIMENSIONS[config.vectorType];
      if (config.dimensions > maximum) {
        context.addIssue({
          code: "custom",
          path: ["dimensions"],
          message: `must be between 1 and ${maximum} for ${config.vectorType}`,
        });
      }
    }
  });

/** Caller-facing creation config, inferred from the runtime validator. */
export type IndexConfig = z.input<typeof indexConfigSchema>;

export type VectorType = "vector" | "halfvec";
export type VectorIndexMethod = "hnsw" | "prism";
export type VectorIndexConfig = NonNullable<IndexConfig["vectorIndex"]>;
export type Bm25Config = NonNullable<IndexConfig["bm25"]>;
export type HnswConfig = NonNullable<IndexConfig["hnsw"]>;

export type NormalizedBm25Config = z.output<typeof bm25Schema>;
export type NormalizedHnswConfig = z.output<typeof hnswSchema>;
export type NormalizedVectorIndexConfig =
  | z.output<typeof hnswVectorIndexSchema>
  | z.output<typeof prismVectorIndexSchema>;

/** Fully validated and defaulted creation parameters used to build index DDL. */
export interface NormalizedIndexConfig {
  readonly dimensions: number;
  readonly vectorType: VectorType;
  readonly bm25: NormalizedBm25Config;
  readonly hnsw: NormalizedHnswConfig;
  readonly vectorIndex: NormalizedVectorIndexConfig;
}

const normalizedBrand = Symbol("NormalizedIndexConfig");

/** Validate caller input, apply defaults, and freeze the creation parameters. */
export function normalizeIndexConfig(
  input: IndexConfig | NormalizedIndexConfig,
): NormalizedIndexConfig {
  if (typeof input === "object" && input !== null && normalizedBrand in input) {
    return input as NormalizedIndexConfig;
  }
  const result = indexConfigSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "config"}: ${first.message}`
      : "validation failed";
    throw new InvalidConfigError(`Invalid index configuration: ${detail}`, {
      cause: result.error,
      issues,
    });
  }

  const parsed = result.data;
  const vectorIndex: NormalizedVectorIndexConfig =
    parsed.vectorIndex !== undefined
      ? parsed.vectorIndex
      : {
          method: "hnsw",
          m: parsed.hnsw?.m ?? DEFAULT_HNSW_CONFIG.m,
          efConstruction:
            parsed.hnsw?.efConstruction ?? DEFAULT_HNSW_CONFIG.efConstruction,
        };
  const hnsw: NormalizedHnswConfig =
    vectorIndex.method === "hnsw"
      ? { m: vectorIndex.m, efConstruction: vectorIndex.efConstruction }
      : (parsed.hnsw ?? { ...DEFAULT_HNSW_CONFIG });

  const normalized: NormalizedIndexConfig = {
    dimensions: parsed.dimensions,
    vectorType: parsed.vectorType,
    bm25: parsed.bm25,
    hnsw,
    vectorIndex,
  };
  Object.defineProperty(normalized, normalizedBrand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return deepFreeze(normalized);
}

function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === "object" && item !== null) {
      deepFreeze(item);
    }
  }
  return Object.freeze(value);
}
