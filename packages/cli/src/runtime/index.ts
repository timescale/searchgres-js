import type { EventEmitter } from "node:events";
import { createOpenAI } from "@ai-sdk/openai";
import postgres from "postgres";
import {
  type EmbeddingWorker,
  type EmbeddingWorkerOptions,
  type Index,
  InvalidConfigError,
  LIBRARY_VERSION,
  noTruncation,
  openIndex,
  type Truncator,
  truncateBytes,
  truncateCharacters,
} from "searchgres";
import {
  type RuntimeConfig,
  readRequiredEnvironment,
} from "../config/config.ts";
import { assertConfiguredIndexShape } from "../config/index-shape.ts";
import { presentQueueStats } from "../presentation/index.ts";
import { TokenizerPool } from "../tokenizer/tokenizer-pool.ts";
import { safeError } from "./report.ts";

export const SHUTDOWN_GRACE_MS = 60_000;
export function createPool(config: RuntimeConfig) {
  const settings = config.database;
  try {
    return postgres(readRequiredEnvironment(settings.urlEnv), {
      max: settings.pool.max,
      idle_timeout: settings.pool.idleReap / 1000,
      max_lifetime: settings.pool.maxLifetime / 1000,
      connect_timeout: settings.pool.connectTimeout / 1000,
      onnotice: () => {},
      connection: {
        application_name: "searchgres",
        statement_timeout: settings.session.statementTimeout,
        lock_timeout: settings.session.lockTimeout,
        transaction_timeout: settings.session.transactionTimeout,
        idle_in_transaction_session_timeout:
          settings.session.idleInTransactionSessionTimeout,
      },
    });
  } catch (error) {
    if (error instanceof InvalidConfigError) throw error;
    throw new InvalidConfigError("Cannot configure PostgreSQL connection", {
      cause: error,
    });
  }
}

export interface DirectRuntime {
  readonly config: RuntimeConfig;
  readonly index: Index;
  readonly workerCount: number;
  run<T>(operation: () => Promise<T>): Promise<T>;
  startEmbeddingWorkers(count?: number, options?: EmbeddingWorkerOptions): void;
  info(readOnly?: boolean): Promise<unknown>;
  close(): Promise<void>;
}

export async function openRuntime(
  config: RuntimeConfig,
): Promise<DirectRuntime> {
  const sql = createPool(config);
  let closed = false;
  let tokenizer: TokenizerPool | undefined;
  let model:
    | ReturnType<ReturnType<typeof createOpenAI>["embedding"]>
    | undefined;
  const getModel = () => {
    if (closed) throw new Error("Runtime is closing");
    if (!model) {
      const e = config.embedding;
      const baseURL = e.baseUrlEnv
        ? readRequiredEnvironment(e.baseUrlEnv)
        : e.baseUrl;
      if (baseURL) {
        let parsed: URL;
        try {
          parsed = new URL(baseURL);
        } catch {
          throw new InvalidConfigError("Invalid embedding base URL");
        }
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new InvalidConfigError("Embedding URL must use HTTP or HTTPS");
      }
      const provider = createOpenAI({
        apiKey: e.apiKeyEnv
          ? readRequiredEnvironment(e.apiKeyEnv)
          : "searchgres",
        ...(baseURL ? { baseURL } : {}),
        fetch: Object.assign(
          (
            input: Parameters<typeof fetch>[0],
            init?: Parameters<typeof fetch>[1],
          ) =>
            fetch(input, {
              ...init,
              signal: AbortSignal.any([
                AbortSignal.timeout(e.requestTimeout),
                ...(init?.signal ? [init.signal] : []),
              ]),
            }),
          { preconnect: fetch.preconnect },
        ),
      });
      model = provider.embedding(e.model);
    }
    return model;
  };
  // Core can open/validate the index without resolving a provider key. Metadata
  // and doEmbed are resolved only when core actually generates embeddings.
  const embedding = {
    specificationVersion: "v4" as const,
    provider: "openai",
    modelId: config.embedding.model,
    get maxEmbeddingsPerCall() {
      return getModel().maxEmbeddingsPerCall;
    },
    get supportsParallelCalls() {
      return getModel().supportsParallelCalls;
    },
    doEmbed: (options: Parameters<ReturnType<typeof getModel>["doEmbed"]>[0]) =>
      getModel().doEmbed(options),
  };
  let baseTruncate: Truncator;
  const t = config.embedding.truncate;
  switch (t.kind) {
    case "none":
      baseTruncate = noTruncation;
      break;
    case "characters":
      baseTruncate = truncateCharacters(t.max);
      break;
    case "bytes":
      baseTruncate = truncateBytes(t.max);
      break;
    case "tokens":
      baseTruncate = async (text) => {
        if (closed) throw new Error("Runtime is closing");
        tokenizer ??= new TokenizerPool({
          preset: t.tokenizer,
          maxTokens: t.maxTokens,
          ...(t.threads === undefined ? {} : { threads: t.threads }),
        });
        return tokenizer.truncate(text);
      };
      break;
  }
  const workers: EmbeddingWorker[] = [];
  const active = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  try {
    const index = await openIndex(sql, config.index.schema, {
      embedding,
      truncate: baseTruncate,
      documentPrefix: config.embedding.documentPrefix,
      queryPrefix: config.embedding.queryPrefix,
    });
    assertConfiguredIndexShape(index, config.index);
    return {
      config,
      index,
      get workerCount() {
        return workers.length;
      },
      async run<T>(operation: () => Promise<T>): Promise<T> {
        if (closing) throw new Error("Runtime is closing");
        const result = Promise.resolve().then(operation);
        active.add(result);
        try {
          return await result;
        } finally {
          active.delete(result);
        }
      },
      startEmbeddingWorkers(count = config.worker.count, options = {}) {
        if (closing || workers.length)
          throw new InvalidConfigError(
            "Worker pool already started or closing",
          );
        if (!Number.isInteger(count) || count < 0 || count > 64)
          throw new InvalidConfigError("workers must be between 0 and 64");
        if (count > 0) getModel(); // fail startup on missing configuration, not silently retry forever
        for (let i = 0; i < count; i++)
          workers.push(
            index.startEmbeddingWorker({
              intervalMs: config.worker.interval,
              batchSize: config.worker.batchSize,
              onError: (error, context) =>
                console.error(
                  JSON.stringify({
                    error: safeError(error),
                    ...(context.stopped ? { workerStopped: true } : {}),
                  }),
                ),
              ...options,
            }),
          );
      },
      async info(readOnly = false) {
        return {
          libraryVersion: LIBRARY_VERSION,
          index: {
            schema: index.schema,
            dimensions: index.dimensions,
            vectorType: index.vectorType,
            vectorIndex: index.vectorIndex,
          },
          capabilities: {
            semantic: true,
            fulltext: true,
            hybrid: true,
            mutations: !readOnly,
          },
          embedding: {
            model: config.embedding.model,
            workerCount: workers.length,
            truncation: t.kind,
          },
          queue: presentQueueStats(await index.queueStats()),
        };
      },
      close() {
        closing ??= (async () => {
          // Don't mark resources closed until existing foreground operations and
          // worker batches finish; they may still need first-use tokenization.
          await Promise.allSettled([
            ...workers.map((worker) => worker.stop()),
            ...active,
          ]);
          closed = true;
          await tokenizer?.shutdown();
          await sql.end();
        })();
        return closing;
      },
    };
  } catch (error) {
    closed = true;
    await tokenizer?.shutdown();
    await sql.end();
    throw error;
  }
}

/** Binary-owned lifecycle: forced exit is not a claim that operations rolled back. */
export function installShutdown(
  close: () => Promise<void>,
  onClosing: () => void = () => {},
  graceMs = SHUTDOWN_GRACE_MS,
): { stop: () => Promise<void>; dispose: () => void } {
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      onClosing();
      const timer = setTimeout(() => {
        console.error(
          "searchgres.js shutdown grace expired; unfinished operations may have completed. Queue leases will recover abandoned claims.",
        );
        process.exit(1);
      }, graceMs);
      try {
        await close();
      } finally {
        clearTimeout(timer);
        dispose();
      }
    })();
    return stopping;
  };
  const signal = () => {
    void stop().catch((error) => {
      console.error(JSON.stringify({ error: safeError(error) }));
      process.exitCode = 1;
    });
  };
  const dispose = () => {
    (process as EventEmitter).removeListener("SIGINT", signal);
    (process as EventEmitter).removeListener("SIGTERM", signal);
  };
  process.on("SIGINT", signal);
  process.on("SIGTERM", signal);
  return { stop, dispose };
}
