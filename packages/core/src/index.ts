/**
 * searchgres.js — Postgres-native hybrid search.
 *
 * Public entry point. Everything a consumer can use is re-exported here; any
 * module not reachable from this file is internal and may change without a
 * major version bump.
 */

export * from "./config.ts";
export * from "./create-index.ts";
export type {
  EmbeddingFailure,
  ListEmbeddingFailuresOptions,
  QueueStats,
  RetryEmbeddingFailuresOptions,
  RetryEmbeddingFailuresResult,
} from "./db/embedding-queue.ts";
export {
  type EnsureExtensionsOptions,
  type ExtensionInfo,
  type ExtensionRequirement,
  ensureExtensions,
  REQUIRED_EXTENSIONS,
} from "./db/extensions.ts";
export { dropIndex } from "./drop-index.ts";
export { noEmbedding } from "./embedding.ts";
export type {
  EmbeddingWorker,
  EmbeddingWorkerOptions,
  ProcessEmbeddingsOptions,
  ProcessEmbeddingsResult,
  WorkerErrorContext,
} from "./embedding-worker.ts";
export * from "./errors.ts";
export * from "./identifiers.ts";
export {
  type MigrateIndexOptions,
  type MigrateIndexResult,
  migrateIndex,
} from "./migrate-index.ts";
export * from "./open-index.ts";
export type { PatchInput, StoredRecord } from "./records.ts";
export type {
  Filter,
  SearchOptions,
  SearchResult,
  TemporalRange,
  Timestamp,
} from "./search.ts";
export type {
  TreeCountOptions,
  TreeCountResult,
  TreeCountSelector,
  TreeListEntry,
  TreeMutationOptions,
  TreeMutationResult,
  TreeViewOptions,
} from "./tree.ts";
export {
  noTruncation,
  type TokenCodec,
  type Truncator,
  truncateBytes,
  truncateCharacters,
  truncateTokens,
} from "./truncate.ts";
export { LIBRARY_VERSION } from "./version.ts";
export type { UpsertOptions, UpsertRecord, UpsertResult } from "./write.ts";
