import {
  type Index,
  InvalidConfigError,
  type VectorIndexMethod,
} from "searchgres";
import type { RuntimeConfig } from "./config.ts";

type ConfiguredIndex = Omit<RuntimeConfig["index"], "vectorIndex"> & {
  readonly vectorIndex?: VectorIndexMethod;
};
type OpenedIndexShape = Pick<Index, "schema" | "dimensions" | "vectorType"> & {
  readonly vectorIndex?: VectorIndexMethod;
};

/** Refuse to serve or accept an existing index with a shape unlike the config. */
export function assertConfiguredIndexShape(
  index: OpenedIndexShape,
  configured: ConfiguredIndex,
): void {
  const configuredMethod = configured.vectorIndex ?? "hnsw";
  const actualMethod = index.vectorIndex ?? "hnsw";
  if (
    index.schema === configured.schema &&
    index.dimensions === configured.dimensions &&
    index.vectorType === configured.vectorType &&
    actualMethod === configuredMethod
  ) {
    return;
  }
  const methodSuffix =
    actualMethod !== configuredMethod
      ? ` (${configuredMethod} vs ${actualMethod})`
      : "";
  throw new InvalidConfigError(
    `Index ${JSON.stringify(configured.schema)} does not match the config: ` +
      `configured ${configured.vectorType}(${configured.dimensions}), ` +
      `database has ${index.vectorType}(${index.dimensions})${methodSuffix}`,
  );
}
