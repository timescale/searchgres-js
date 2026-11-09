/** Stable machine-readable error codes exposed by searchgres. */
export type SearchgresErrorCode =
  | "BATCH_TOO_LARGE"
  | "CONFLICT"
  | "DIMENSION_MISMATCH"
  | "EMBEDDING_PROVIDER"
  | "EMBEDDING_UNAVAILABLE"
  | "EXTENSION"
  | "INVALID_CONFIG"
  | "INVALID_INDEX"
  | "INVALID_INPUT"
  | "LOCK_TIMEOUT"
  | "NOT_FOUND"
  | "STATEMENT_TIMEOUT"
  | "RATE_LIMITED"
  | "SCHEMA_VERSION"
  | "STALE_VERSION"
  | "TRANSACTION_TIMEOUT"
  | "TREE_PATH"
  | "UNSUPPORTED_SERVER";

/** Validator-neutral issue shape retained on typed validation errors. */
export interface ValidationIssue {
  readonly code: string;
  readonly message: string;
  readonly path: readonly (number | string)[];
}

/** Base class for every error intentionally raised by searchgres. */
export class SearchgresError extends Error {
  readonly code: SearchgresErrorCode;

  constructor(
    code: SearchgresErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class InvalidIndexError extends SearchgresError {
  readonly schema: string;

  constructor(
    schema: string,
    options?: ErrorOptions & { readonly detail?: string },
  ) {
    const suffix = options?.detail ? `: ${options.detail}` : "";
    super(
      "INVALID_INDEX",
      `Schema ${JSON.stringify(schema)} is not a searchgres index${suffix}`,
      options,
    );
    this.schema = schema;
  }
}

/** @internal Oldest schema format version accepted by `migrateIndex`. */
export const MINIMUM_MIGRATABLE_SCHEMA_VERSION = "2";

const CANONICAL_SCHEMA_VERSION_RE = /^[1-9][0-9]*$/;

/** @internal Parse a canonical positive decimal schema-version string as a BigInt. */
export function parseSchemaVersion(version: string): bigint | null {
  if (!CANONICAL_SCHEMA_VERSION_RE.test(version)) {
    return null;
  }
  return BigInt(version);
}

/**
 * @internal Compare two canonical positive decimal schema-version strings
 * numerically, never lexically ("10" > "3"). Returns null if either string is
 * malformed.
 */
export function compareSchemaVersions(
  left: string,
  right: string,
): -1 | 0 | 1 | null {
  const l = parseSchemaVersion(left);
  const r = parseSchemaVersion(right);
  if (l === null || r === null) {
    return null;
  }
  return l < r ? -1 : l > r ? 1 : 0;
}

function schemaVersionMessage(
  schema: string,
  schemaVersion: string,
  supportedVersion: string,
): string {
  const cmp = compareSchemaVersions(schemaVersion, supportedVersion);
  if (cmp === 1) {
    return `Index ${JSON.stringify(schema)} uses newer schema format ${schemaVersion}; this library supports ${supportedVersion}. Upgrade searchgres to a compatible version.`;
  }
  const actual = parseSchemaVersion(schemaVersion);
  const supported = parseSchemaVersion(supportedVersion);
  const minimumMigratable = BigInt(MINIMUM_MIGRATABLE_SCHEMA_VERSION);
  if (
    actual !== null &&
    supported !== null &&
    actual >= minimumMigratable &&
    actual < supported
  ) {
    return `Index ${JSON.stringify(schema)} uses schema format ${schemaVersion}; this library supports ${supportedVersion}. Run migrateIndex or searchgres migrate before opening the index.`;
  }
  return `Index ${JSON.stringify(schema)} uses schema format ${schemaVersion}; this library supports ${supportedVersion}. Create a new index and reindex.`;
}

export class SchemaVersionError extends SearchgresError {
  readonly schema: string;
  readonly schemaVersion: string;
  readonly supportedVersion: string;

  constructor(
    schema: string,
    schemaVersion: string,
    supportedVersion: string,
    options?: ErrorOptions,
  ) {
    super(
      "SCHEMA_VERSION",
      schemaVersionMessage(schema, schemaVersion, supportedVersion),
      options,
    );
    this.schema = schema;
    this.schemaVersion = schemaVersion;
    this.supportedVersion = supportedVersion;
  }
}

/**
 * Common shape of the two validation errors. `InvalidConfigError` covers how
 * an index is created or opened; `InvalidInputError` covers per-call input to
 * an open index. Surfaces that only need `issues` can match on this base.
 */
export abstract class ValidationError extends SearchgresError {
  readonly issues: readonly ValidationIssue[];

  constructor(
    code: "INVALID_CONFIG" | "INVALID_INPUT",
    message: string,
    options?: ErrorOptions & { readonly issues?: readonly ValidationIssue[] },
  ) {
    super(code, message, options);
    this.issues = Object.freeze(
      (options?.issues ?? []).map((issue) =>
        Object.freeze({
          code: issue.code,
          message: issue.message,
          path: Object.freeze([...issue.path]),
        }),
      ),
    );
  }
}

/**
 * Invalid index configuration or handle setup: `createIndex` config, schema
 * names, `openIndex` options, and truncator construction.
 */
export class InvalidConfigError extends ValidationError {
  constructor(
    message: string,
    options?: ErrorOptions & { readonly issues?: readonly ValidationIssue[] },
  ) {
    super("INVALID_CONFIG", message, options);
  }
}

/**
 * Invalid input to an operation on an open index: a malformed record, patch,
 * search option, filter, tree selector, or a pattern (`lquery`, `ltxtquery`,
 * `regexp`, JSONPath) that PostgreSQL rejected. When PostgreSQL rejected the
 * input, `cause` is the driver error and the single issue's `code` is its
 * SQLSTATE.
 */
export class InvalidInputError extends ValidationError {
  constructor(
    message: string,
    options?: ErrorOptions & { readonly issues?: readonly ValidationIssue[] },
  ) {
    super("INVALID_INPUT", message, options);
  }
}

export class TreePathError extends SearchgresError {
  readonly path: string;

  constructor(path: string, message: string, options?: ErrorOptions) {
    super("TREE_PATH", message, options);
    this.path = path;
  }
}

export class DimensionMismatchError extends SearchgresError {
  readonly expected: number;
  readonly actual: number;
  /** Zero-based index of the offending record within a batch write. */
  readonly position: number | undefined;

  constructor(
    expected: number,
    actual: number,
    options?: ErrorOptions & { readonly position?: number },
  ) {
    const position = options?.position;
    const at = position === undefined ? "" : ` at record ${position}`;
    super(
      "DIMENSION_MISMATCH",
      `Embedding dimension mismatch${at}: index expects ${expected}, received ${actual}`,
      options,
    );
    this.expected = expected;
    this.actual = actual;
    this.position = position;
  }
}

export class UnsupportedServerError extends SearchgresError {
  readonly serverVersionNum: number;
  readonly minimumVersionNum: number;

  constructor(
    serverVersionNum: number,
    minimumVersionNum: number,
    options?: ErrorOptions,
  ) {
    super(
      "UNSUPPORTED_SERVER",
      Number.isFinite(serverVersionNum)
        ? `PostgreSQL ${minimumVersionNum} or newer is required; server reports ${serverVersionNum}`
        : `PostgreSQL ${minimumVersionNum} or newer is required; the server did not report a parseable server_version_num`,
      options,
    );
    this.serverVersionNum = serverVersionNum;
    this.minimumVersionNum = minimumVersionNum;
  }
}

export type ExtensionErrorReason =
  | "incomplete_setup"
  | "missing"
  | "permission_denied"
  | "too_old"
  | "unavailable"
  | "wrong_schema";

export class ExtensionError extends SearchgresError {
  readonly extension: string;
  readonly minimumVersion: string;
  readonly foundVersion: string | null;
  readonly reason: ExtensionErrorReason;

  constructor(
    extension: string,
    minimumVersion: string,
    reason: ExtensionErrorReason,
    options?: ErrorOptions & { readonly foundVersion?: string | null },
  ) {
    const foundVersion = options?.foundVersion ?? null;
    const detail = foundVersion ? `; found ${foundVersion}` : "";
    const guidance =
      reason === "permission_denied"
        ? "; install it before connecting or grant CREATE EXTENSION"
        : reason === "wrong_schema"
          ? "; searchgres requires it in the public schema"
          : reason === "incomplete_setup"
            ? "; run SELECT public.pg_vectorsearch_setup_pgvector_compat() as a superuser"
            : "";
    super(
      "EXTENSION",
      `PostgreSQL extension ${JSON.stringify(extension)} >= ${minimumVersion} is required (${reason}${detail}${guidance})`,
      options,
    );
    this.extension = extension;
    this.minimumVersion = minimumVersion;
    this.foundVersion = foundVersion;
    this.reason = reason;
  }
}

export class StatementTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL statement timed out",
    options?: ErrorOptions,
  ) {
    super("STATEMENT_TIMEOUT", message, options);
  }
}

export class LockTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL lock wait timed out",
    options?: ErrorOptions,
  ) {
    super("LOCK_TIMEOUT", message, options);
  }
}

export class TransactionTimeoutError extends SearchgresError {
  constructor(
    message = "PostgreSQL transaction timed out",
    options?: ErrorOptions,
  ) {
    super("TRANSACTION_TIMEOUT", message, options);
  }
}

export class NotFoundError extends SearchgresError {
  /**
   * The requested id, or a human-readable `(tree, name)` address such as
   * `tree "docs", name "intro"`.
   */
  readonly target: string;

  constructor(
    target: string | { readonly tree: string; readonly name: string },
    options?: ErrorOptions,
  ) {
    const address =
      typeof target === "string"
        ? undefined
        : `tree ${JSON.stringify(target.tree)}, name ${JSON.stringify(target.name)}`;
    super(
      "NOT_FOUND",
      address === undefined
        ? `Record ${JSON.stringify(target)} was not found`
        : `Record with ${address} was not found`,
      options,
    );
    this.target = address ?? (target as string);
  }
}

export class StaleVersionError extends SearchgresError {
  readonly id: string;

  constructor(id: string, options?: ErrorOptions) {
    super(
      "STALE_VERSION",
      `Record ${JSON.stringify(id)} has changed since it was read`,
      options,
    );
    this.id = id;
  }
}

export class ConflictError extends SearchgresError {
  constructor(message: string, options?: ErrorOptions) {
    super("CONFLICT", message, options);
  }
}

export class BatchTooLargeError extends SearchgresError {
  readonly size: number;
  readonly maximum: number;

  constructor(size: number, maximum: number, options?: ErrorOptions) {
    super(
      "BATCH_TOO_LARGE",
      `Batch contains ${size} records; the maximum is ${maximum}`,
      options,
    );
    this.size = size;
    this.maximum = maximum;
  }
}

export class EmbeddingProviderError extends SearchgresError {
  constructor(message: string, options?: ErrorOptions) {
    super("EMBEDDING_PROVIDER", message, options);
  }
}

/**
 * The index handle was opened with `noEmbedding`, so it cannot generate
 * vectors. Thrown before any queue row is claimed or any query is sent;
 * queued work stays pending for a handle opened with a real model.
 */
export class EmbeddingUnavailableError extends SearchgresError {
  /** The operation that needed an embedding model. */
  readonly operation: string;

  constructor(operation: string, options?: ErrorOptions) {
    super(
      "EMBEDDING_UNAVAILABLE",
      `Cannot ${operation}: this index was opened with \`noEmbedding\`. Reopen it with an embedding model.`,
      options,
    );
    this.operation = operation;
  }
}

export class RateLimitError extends SearchgresError {
  readonly retryAfterMs: number | undefined;

  constructor(
    message = "Embedding provider rate limit exceeded",
    retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super("RATE_LIMITED", message, options);
    this.retryAfterMs = retryAfterMs;
  }
}
