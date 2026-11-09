import { embed, embedMany } from "ai";
import {
  DimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  InvalidConfigError,
  RateLimitError,
} from "./errors.ts";
import type { Index, IndexEmbeddingModel } from "./open-index.ts";
import { runOperation } from "./operation.ts";

/** Fallback when a model reports no finite `maxEmbeddingsPerCall`. */
const DEFAULT_BATCH_SIZE = 10;
/** Cap on a stored `last_error` so a verbose provider payload can't bloat the row. */
export const MAX_ERROR_LENGTH = 2048;

/**
 * An embedding model for handles that never generate vectors: ingest-only
 * processes, precomputed-vector pipelines, or BM25/filter-only search.
 *
 * Writes with a null embedding still queue as usual; a handle opened with a
 * real model drains them later. Operations that need a model — semantic text
 * search, `processEmbeddings`, `startEmbeddingWorker` — throw
 * `EmbeddingUnavailableError` before touching the queue or the database.
 * Compare by identity: `index.embedding === noEmbedding`.
 */
export const noEmbedding: IndexEmbeddingModel = Object.freeze({
  specificationVersion: "v4" as const,
  provider: "searchgres",
  modelId: "none",
  maxEmbeddingsPerCall: Number.POSITIVE_INFINITY,
  supportsParallelCalls: false,
  doEmbed(): never {
    // Backstop only: searchgres guards its own entry points before reaching
    // the AI SDK, but a caller may hand this object to `embed()` directly.
    throw new EmbeddingUnavailableError("embed");
  },
});

/** Throw before any queue or database work when the handle has no model. */
export function assertEmbeddingAvailable(
  index: Pick<Index, "embedding">,
  operation: string,
): void {
  if (index.embedding === noEmbedding) {
    throw new EmbeddingUnavailableError(operation);
  }
}

/** What an embedding input is: record content, or semantic query text. */
export type EmbeddingRole = "document" | "query";

function prefixFor(index: Index, role: EmbeddingRole): string {
  return role === "document" ? index.documentPrefix : index.queryPrefix;
}

/**
 * Throw {@link InvalidConfigError} when the prefix for `role` does not fit the
 * truncation budget. Every truncator returns a text that fits unchanged, so
 * the prefix fits exactly when the truncator returns it unchanged. A cut
 * prefix would make every input for this role wrong, so callers check before
 * they claim work or call the provider.
 */
export async function assertPrefixFits(
  index: Index,
  role: EmbeddingRole,
): Promise<void> {
  const prefix = prefixFor(index, role);
  if (prefix === "" || (await index.truncate(prefix)) === prefix) {
    return;
  }
  const name = role === "document" ? "documentPrefix" : "queryPrefix";
  throw new InvalidConfigError(
    `${name} does not fit the truncation budget: the truncator shortens the prefix alone. Use a larger budget or a shorter prefix`,
    {
      issues: [
        {
          code: "custom",
          message: "prefix exceeds the truncation budget",
          path: [name],
        },
      ],
    },
  );
}

/**
 * Embed one query string for search. Applies the query prefix and the index
 * truncator, checks the returned dimension, and maps provider failures to
 * typed errors.
 */
export async function embedQuery(
  index: Index,
  text: string,
): Promise<readonly number[]> {
  await assertPrefixFits(index, "query");
  const [vector] = await embedTexts(index, [text], "query");
  if (!vector) {
    throw new EmbeddingProviderError("Embedding provider returned no vector");
  }
  return vector;
}

/**
 * Embed a batch of texts through the index's model. The prefix for `role` is
 * put before each value, and truncation is then applied per value (identical
 * policy to query embedding), so the prefix counts toward the budget. Callers
 * check the prefix with {@link assertPrefixFits} first. Every returned
 * vector's length is validated against the index dimensions, and errors are
 * normalized:
 *  - a provider rate limit → {@link RateLimitError} (carrying retry-after);
 *  - a wrong vector length → {@link DimensionMismatchError};
 *  - anything else → {@link EmbeddingProviderError}.
 *
 * Ordering is preserved: `embedMany` returns vectors in input order, so callers
 * pair them with their inputs positionally.
 */
export async function embedTexts(
  index: Index,
  texts: readonly string[],
  role: EmbeddingRole,
): Promise<readonly (readonly number[])[]> {
  return runOperation(
    "searchgres.embedding.generate",
    {
      schema: index.schema,
      attributes: { "searchgres.embedding.count": texts.length },
    },
    async (span) => {
      const prefix = prefixFor(index, role);
      const inputs = texts.map((text) => `${prefix}${text}`);
      const truncated = await Promise.all(
        inputs.map((input) => index.truncate(input)),
      );
      const anyTruncated = truncated.some(
        (value, position) => value.length !== inputs[position]?.length,
      );
      span.setAttribute("searchgres.embedding.truncated", anyTruncated);

      let embeddings: number[][];
      try {
        if (truncated.length === 1) {
          const only = truncated[0] as string;
          const result = await embed({ model: index.embedding, value: only });
          embeddings = [result.embedding];
        } else {
          const result = await embedMany({
            model: index.embedding,
            values: truncated,
          });
          embeddings = result.embeddings;
        }
      } catch (error) {
        throw mapProviderError(error);
      }

      for (const embedding of embeddings) {
        if (embedding.length !== index.dimensions) {
          // A wrong dimension is a configuration fault (a model that doesn't
          // match the column typmod), not a per-record failure — surface it.
          throw new DimensionMismatchError(index.dimensions, embedding.length);
        }
      }
      return embeddings;
    },
  );
}

/**
 * The number of rows to claim/embed per batch. A caller request is clamped to
 * the model's `maxEmbeddingsPerCall` so one claim maps to exactly one provider
 * call; with no request and no finite model limit, use a small default.
 */
export async function resolveBatchSize(
  index: Index,
  requested: number | undefined,
): Promise<number> {
  const modelMax = await modelMaxEmbeddingsPerCall(index.embedding);
  if (requested !== undefined) {
    return modelMax === undefined
      ? requested
      : Math.max(1, Math.min(requested, modelMax));
  }
  return modelMax ?? DEFAULT_BATCH_SIZE;
}

async function modelMaxEmbeddingsPerCall(
  model: Index["embedding"],
): Promise<number | undefined> {
  if (typeof model !== "object" || model === null) {
    return undefined;
  }
  const raw = await Promise.resolve(
    (
      model as {
        maxEmbeddingsPerCall?: PromiseLike<number | undefined> | number;
      }
    ).maxEmbeddingsPerCall,
  );
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.floor(raw)
    : undefined;
}

function mapProviderError(error: unknown): Error {
  if (isRateLimitError(error)) {
    return new RateLimitError(
      extractProviderMessage(error) ?? "Embedding provider rate limit exceeded",
      extractRetryAfterMs(error),
      { cause: error },
    );
  }
  return new EmbeddingProviderError("Failed to generate embeddings", {
    cause: error,
  });
}

/** Clamp an error message (including its cause) to a bounded, storable length. */
export function boundedError(error: unknown): string {
  let message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  // Provider failures are wrapped in EmbeddingProviderError; surface the
  // underlying cause so `last_error` says what actually went wrong.
  if (error instanceof Error && error.cause != null) {
    const cause =
      error.cause instanceof Error ? error.cause.message : String(error.cause);
    if (cause.length > 0 && !message.includes(cause)) {
      message = `${message}: ${cause}`;
    }
  }
  return message.length > MAX_ERROR_LENGTH
    ? message.slice(0, MAX_ERROR_LENGTH)
    : message;
}

// ---------------------------------------------------------------------------
// rate-limit detection (AI SDK error shapes)
// ---------------------------------------------------------------------------

/** True if `error` (or a wrapped inner error) is an HTTP 429. */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof RateLimitError) {
    return true;
  }
  if (hasStatusCode(error, 429)) {
    return true;
  }
  if (hasLastError(error) && isRateLimitError(error.lastError)) {
    return true;
  }
  if (hasErrors(error)) {
    return error.errors.some((inner) => hasStatusCode(inner, 429));
  }
  return false;
}

function extractRetryAfterMs(error: unknown): number | undefined {
  const headers = responseHeaders(error);
  if (!headers) {
    return undefined;
  }
  const retryAfterMs = headers["retry-after-ms"];
  if (retryAfterMs) {
    const ms = Number.parseFloat(retryAfterMs);
    if (!Number.isNaN(ms) && ms > 0) {
      return ms;
    }
  }
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter);
    if (!Number.isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) {
      const ms = date - Date.now();
      if (ms > 0) {
        return ms;
      }
    }
  }
  return undefined;
}

function extractProviderMessage(error: unknown): string | undefined {
  if (hasStatusCode(error, 429)) {
    return readMessage(error);
  }
  if (hasLastError(error)) {
    const message = extractProviderMessage(error.lastError);
    if (message) {
      return message;
    }
  }
  if (hasErrors(error)) {
    for (const inner of error.errors) {
      if (hasStatusCode(inner, 429)) {
        const message = readMessage(inner);
        if (message) {
          return message;
        }
      }
    }
  }
  return undefined;
}

function readMessage(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    const message = (error as { message: string }).message;
    return message.length > 0 ? message : undefined;
  }
  return undefined;
}

function hasStatusCode(
  error: unknown,
  expected: number,
): error is { statusCode: number } {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode: unknown }).statusCode === expected
  );
}

function hasLastError(error: unknown): error is { lastError: unknown } {
  return error !== null && typeof error === "object" && "lastError" in error;
}

function hasErrors(error: unknown): error is { errors: unknown[] } {
  return (
    error !== null &&
    typeof error === "object" &&
    "errors" in error &&
    Array.isArray((error as { errors: unknown }).errors)
  );
}

function responseHeaders(error: unknown): Record<string, string> | undefined {
  if (hasResponseHeaders(error)) {
    return error.responseHeaders;
  }
  if (hasLastError(error) && hasResponseHeaders(error.lastError)) {
    return error.lastError.responseHeaders;
  }
  if (hasErrors(error)) {
    for (const inner of error.errors) {
      if (hasResponseHeaders(inner)) {
        return inner.responseHeaders;
      }
    }
  }
  return undefined;
}

function hasResponseHeaders(
  error: unknown,
): error is { responseHeaders: Record<string, string> } {
  return (
    error !== null &&
    typeof error === "object" &&
    "responseHeaders" in error &&
    typeof (error as { responseHeaders: unknown }).responseHeaders ===
      "object" &&
    (error as { responseHeaders: unknown }).responseHeaders !== null
  );
}
