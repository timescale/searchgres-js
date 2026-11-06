import {
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  ExtensionError,
  InvalidConfigError,
  InvalidIndexError,
  InvalidInputError,
  LockTimeoutError,
  NotFoundError,
  SchemaVersionError,
  SearchgresError,
  StaleVersionError,
  StatementTimeoutError,
  TransactionTimeoutError,
  TreePathError,
  UnsupportedServerError,
  ValidationError,
} from "searchgres";
import { z } from "zod";

export class InputError extends Error {}

/**
 * Reduce any failure to a stable code and a message safe to print or return
 * to an MCP host.
 *
 * Messages are retained for the errors in RETAINED_MESSAGES. Core or this
 * binary composes them only from the caller's own request (ids, names,
 * version hashes) and from catalog facts (schema, extension, dimensions,
 * limits). The caller needs them to correct the problem. Every other message
 * is replaced by its code, because provider, driver, and unexpected errors
 * can carry remote text, connection details, or secrets. For those, only a
 * safe failure class (HTTP status, SQLSTATE, or error code) is added.
 */
export function safeError(error: unknown): {
  code: string;
  message: string;
  issues?: readonly {
    code: string;
    path: readonly (string | number)[];
    message: string;
  }[];
} {
  if (error instanceof InputError)
    return { code: "INVALID_INPUT", message: error.message };
  if (error instanceof z.ZodError)
    return {
      code: "INVALID_INPUT",
      message: "Invalid input; check fields and values",
      issues: error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path.map(String),
        message: issue.message,
      })),
    };
  if (error instanceof SearchgresError) {
    const retainMessage = RETAINED_MESSAGES.some(
      (type) => error instanceof type,
    );
    const failure = failureClass(error.cause);
    return {
      code: error.code,
      message: retainMessage
        ? `${error.message}${failure ? ` (${failure})` : ""}`
        : `searchgres.js operation failed (${[error.code, failure].filter(Boolean).join(", ")})`,
      ...(error instanceof ValidationError && error.issues.length > 0
        ? {
            issues: error.issues.map((issue) => ({
              code: issue.code,
              path: issue.path,
              message: issue.message,
            })),
          }
        : {}),
    };
  }
  const failure = failureClass(error);
  return {
    code: "INTERNAL",
    message: `searchgres.js operation failed${failure ? ` (${failure})` : ""}; check database connectivity and configuration`,
  };
}

const RETAINED_MESSAGES = [
  BatchTooLargeError,
  ConflictError,
  DimensionMismatchError,
  EmbeddingProviderError,
  EmbeddingUnavailableError,
  ExtensionError,
  InvalidConfigError,
  InvalidIndexError,
  InvalidInputError,
  LockTimeoutError,
  NotFoundError,
  SchemaVersionError,
  StaleVersionError,
  StatementTimeoutError,
  TransactionTimeoutError,
  TreePathError,
  UnsupportedServerError,
];

/**
 * Find a safe failure class in an error or its causes: an HTTP status, a
 * SQLSTATE, or a system error code such as ECONNREFUSED. The result never
 * contains message text.
 */
function failureClass(error: unknown): string | undefined {
  for (let depth = 0; depth < 5 && error instanceof Object; depth++) {
    const { statusCode, code } = error as {
      statusCode?: unknown;
      code?: unknown;
    };
    if (typeof statusCode === "number" && statusCode >= 100 && statusCode < 600)
      return `HTTP ${statusCode}`;
    if (typeof code === "string") {
      if (/^(?=.*[0-9])[0-9A-Z]{5}$/.test(code)) return `SQLSTATE ${code}`;
      if (/^[A-Z][A-Za-z_]{2,40}$/.test(code)) return code;
    }
    // The AI SDK RetryError keeps the last attempt in `lastError`.
    const next = error as { cause?: unknown; lastError?: unknown };
    error = next.cause ?? next.lastError;
  }
  return undefined;
}
export function exitCode(error: unknown): number {
  const code = safeError(error).code;
  // 2: the caller's request cannot succeed as written (malformed input, or a
  // deterministic record-state mismatch such as a missing id or stale hash).
  // 1: the environment failed (database, provider, configuration).
  return [
    "INVALID_INPUT",
    "TREE_PATH",
    "BATCH_TOO_LARGE",
    "NOT_FOUND",
    "CONFLICT",
    "STALE_VERSION",
  ].includes(code)
    ? 2
    : 1;
}
