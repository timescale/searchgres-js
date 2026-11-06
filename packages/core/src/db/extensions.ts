import type postgres from "postgres";
import semver from "semver";
import { z } from "zod";
import type { VectorIndexMethod, VectorType } from "../config.ts";
import { ExtensionError, InvalidConfigError } from "../errors.ts";
import { normalizeMigrationOptions } from "../migrate-index.ts";
import { runOperation } from "../operation.ts";
import { postgresErrorCode } from "../sql/errors.ts";
import { runSql } from "../sql/exec.ts";
import { toValidationIssue } from "../validation.ts";
import { acquireAdvisoryLock, EXTENSIONS_LOCK_KEY } from "./lock.ts";
import { ensurePostgresVersion } from "./preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_TIMEOUTS,
  setLockTimeout,
} from "./session.ts";

export interface ExtensionRequirement {
  readonly name: string;
  readonly minimumVersion: string;
}

/**
 * The extensions every index depends on, with the oldest version whose behavior
 * searchgres has verified. `ensureExtensions` installs any that are missing;
 * `createIndex`, `migrateIndex`, and `openIndex` verify presence, version, and
 * `public` placement without running `CREATE EXTENSION`.
 */
export const REQUIRED_EXTENSIONS: readonly ExtensionRequirement[] = [
  { name: "vector", minimumVersion: "0.8.0" },
  { name: "pg_textsearch", minimumVersion: "1.4.0" },
  { name: "ltree", minimumVersion: "1.3.0" },
];

/** Additional extension required when an index uses `prism` (`pg_vectorsearch`). */
export const PRISM_EXTENSION_REQUIREMENT: ExtensionRequirement = Object.freeze({
  name: "pg_vectorsearch",
  minimumVersion: "0.1.0",
});

export function extensionsForVectorIndex(
  method: VectorIndexMethod = "hnsw",
): readonly ExtensionRequirement[] {
  return method === "prism"
    ? [...REQUIRED_EXTENSIONS, PRISM_EXTENSION_REQUIREMENT]
    : REQUIRED_EXTENSIONS;
}

export interface ExtensionInfo {
  readonly name: string;
  readonly version: string;
}

/** Runtime budgets and options for one {@link ensureExtensions} call. */
export interface EnsureExtensionsOptions {
  /**
   * How long to wait for the database-wide extension lock that serializes
   * concurrent `ensureExtensions` calls before throwing
   * {@link LockTimeoutError}. `0` waits indefinitely. Default: 30 000 (30 s).
   */
  readonly lockTimeoutMs?: number;
  /**
   * Wall-clock budget for the extension provisioning transaction before
   * throwing {@link TransactionTimeoutError}. `0` disables the limit.
   * Default: 1 200 000 (20 min).
   */
  readonly transactionTimeoutMs?: number;
  /**
   * When `"prism"`, also install and verify `pg_vectorsearch` in `public`.
   * Default: `"hnsw"`.
   */
  readonly vectorIndex?: VectorIndexMethod;
}

const ensureExtensionsOptionsSchema = z.strictObject({
  lockTimeoutMs: z.int().nonnegative().optional(),
  transactionTimeoutMs: z.int().nonnegative().optional(),
  vectorIndex: z.enum(["hnsw", "prism"]).optional(),
});

/**
 * Install or verify the required PostgreSQL extensions (`vector`,
 * `pg_textsearch`, `ltree`, and `pg_vectorsearch` when `vectorIndex: "prism"`)
 * in `public` under a database-wide advisory lock.
 */
export async function ensureExtensions(
  sql: postgres.Sql,
  options?: EnsureExtensionsOptions,
): Promise<readonly ExtensionInfo[]> {
  return runOperation("searchgres.extensions.ensure", {}, async () => {
    const parsed = ensureExtensionsOptionsSchema.safeParse(options ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map(toValidationIssue);
      const first = issues[0];
      const detail = first
        ? `${first.path.join(".") || "options"}: ${first.message}`
        : "validation failed";
      throw new InvalidConfigError(
        `Invalid ensureExtensions options: ${detail}`,
        {
          cause: parsed.error,
          issues,
        },
      );
    }
    const { vectorIndex = "hnsw", ...budgetOptions } = parsed.data;
    const budgets = normalizeMigrationOptions(
      budgetOptions,
      "ensureExtensions",
    );
    return sql.begin(async (tx) => {
      await applySessionTimeouts(tx, {
        ...DEFAULT_MIGRATION_TIMEOUTS,
        lockTimeout: budgets.lockTimeout,
        transactionTimeout: budgets.transactionTimeout,
      });
      await acquireAdvisoryLock(tx, EXTENSIONS_LOCK_KEY);
      await setLockTimeout(tx, DEFAULT_MIGRATION_TIMEOUTS.lockTimeout);
      await ensurePostgresVersion(tx);
      const installed: ExtensionInfo[] = [];
      for (const requirement of extensionsForVectorIndex(vectorIndex)) {
        installed.push(await ensureExtension(tx, requirement));
      }
      if (vectorIndex === "prism") {
        await assertPrismPgvectorCompat(tx, "vector");
        await assertPrismPgvectorCompat(tx, "halfvec");
      }
      return Object.freeze(installed);
    });
  });
}

/**
 * Verify that `pg_vectorsearch` has registered `public.<=> (public.<vectorType>,
 * public.<vectorType>)` as a strategy-1 ordering operator in `prism`'s cosine
 * operator family.
 */
export async function assertPrismPgvectorCompat(
  sql: postgres.ISql,
  vectorType: VectorType,
): Promise<void> {
  const opclassName =
    vectorType === "vector" ? "vec32_cosine_ops" : "vec16_cosine_ops";
  const [row] = await runSql(
    sql<{ readonly wired: boolean }[]>`
      select exists
      (
        select 1
        from pg_catalog.pg_opclass opc
        inner join pg_catalog.pg_namespace opn on (opn.oid = opc.opcnamespace)
        inner join pg_catalog.pg_am am on (am.oid = opc.opcmethod)
        inner join pg_catalog.pg_amop amop
          on (amop.amopfamily = opc.opcfamily and amop.amopmethod = am.oid)
        inner join pg_catalog.pg_operator opr on (opr.oid = amop.amopopr)
        inner join pg_catalog.pg_namespace oprn on (oprn.oid = opr.oprnamespace)
        inner join pg_catalog.pg_type lt on (lt.oid = amop.amoplefttype)
        inner join pg_catalog.pg_namespace ltn on (ltn.oid = lt.typnamespace)
        where opn.nspname = 'public'
        and opc.opcname = ${opclassName}
        and am.amname = 'prism'
        and amop.amoppurpose = 'o'
        and amop.amopstrategy = 1
        and oprn.nspname = 'public'
        and opr.oprname = '<=>'
        and ltn.nspname = 'public'
        and lt.typname = ${vectorType}
        and amop.amoprighttype = amop.amoplefttype
      ) as wired
    `,
    { spanName: "checkPrismPgvectorCompat", dbOperationName: "SELECT" },
  );
  if (!row?.wired) {
    throw new ExtensionError(
      PRISM_EXTENSION_REQUIREMENT.name,
      PRISM_EXTENSION_REQUIREMENT.minimumVersion,
      "permission_denied",
    );
  }
}

interface ExtensionStatusRow {
  readonly extversion: string | null;
  readonly nspname: string | null;
  readonly default_version: string | null;
}

/**
 * Ensure one required extension is installed in `public` and version-compatible,
 * creating it in `public` when absent. searchgres is public-only: an extension
 * installed in another schema is rejected rather than moved. The caller owns the
 * surrounding transaction and any advisory lock.
 */
export async function ensureExtension(
  tx: postgres.TransactionSql,
  requirement: ExtensionRequirement,
): Promise<ExtensionInfo> {
  const status = await extensionStatus(tx, requirement.name);
  if (status.extversion !== null) {
    return toExtensionInfo(status, requirement);
  }

  if (
    status.default_version === null ||
    !versionAtLeast(status.default_version, requirement.minimumVersion)
  ) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "unavailable",
      { foundVersion: status.default_version },
    );
  }

  try {
    await runSql(
      tx`create extension if not exists ${tx(requirement.name)} with schema public`,
      { spanName: "createExtension", dbOperationName: "CREATE" },
    );
  } catch (error) {
    if (postgresErrorCode(error) === "42501") {
      throw new ExtensionError(
        requirement.name,
        requirement.minimumVersion,
        "permission_denied",
        { cause: error },
      );
    }
    throw error;
  }

  return toExtensionInfo(
    await extensionStatus(tx, requirement.name),
    requirement,
  );
}

/** Read one installed extension without creating or otherwise mutating it. */
export async function getExtensionInfo(
  sql: postgres.ISql,
  requirement: ExtensionRequirement,
): Promise<ExtensionInfo> {
  return toExtensionInfo(
    await extensionStatus(sql, requirement.name),
    requirement,
  );
}

async function extensionStatus(
  tx: postgres.ISql,
  name: string,
): Promise<ExtensionStatusRow> {
  const [status] = await runSql(
    tx<ExtensionStatusRow[]>`
      -- Preserve one status row even when this extension is neither installed
      -- nor available, so the caller receives a typed unavailable error.
      select
        installed.extversion
      , n.nspname
      , available.default_version
      from (select 1) as singleton
      left outer join pg_catalog.pg_extension installed
        on (installed.extname = ${name})
      left outer join pg_catalog.pg_namespace n
        on (n.oid = installed.extnamespace)
      left outer join pg_catalog.pg_available_extensions available
        on (available.name = ${name})
    `,
    { spanName: "checkExtension", dbOperationName: "SELECT" },
  );
  return (
    status ?? {
      extversion: null,
      nspname: null,
      default_version: null,
    }
  );
}

function toExtensionInfo(
  status: ExtensionStatusRow,
  requirement: ExtensionRequirement,
): ExtensionInfo {
  if (status.extversion === null || status.nspname === null) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "missing",
    );
  }
  if (status.nspname !== "public") {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "wrong_schema",
      { foundVersion: status.extversion },
    );
  }
  if (!versionAtLeast(status.extversion, requirement.minimumVersion)) {
    throw new ExtensionError(
      requirement.name,
      requirement.minimumVersion,
      "too_old",
      { foundVersion: status.extversion },
    );
  }
  return Object.freeze({
    name: requirement.name,
    version: status.extversion,
  });
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const parsed = semver.coerce(actual);
  return parsed !== null && semver.gte(parsed, minimum);
}
