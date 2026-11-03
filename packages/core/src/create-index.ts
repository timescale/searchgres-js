import type postgres from "postgres";
import { z } from "zod";
import { type IndexConfig, normalizeIndexConfig } from "./config.ts";
import {
  executeDefinitions,
  indexDefinitions,
  schemaDefinitions,
} from "./db/definitions.ts";
import { ensureExtension, REQUIRED_EXTENSIONS } from "./db/extensions.ts";
import { acquireAdvisoryLock, CREATE_INDEX_LOCK_KEY } from "./db/lock.ts";
import { ensurePostgresVersion } from "./db/preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_LOCK_TIMEOUT,
  DEFAULT_MIGRATION_TIMEOUTS,
  setLockTimeout,
} from "./db/session.ts";
import { indexSqlContext } from "./db/template.ts";
import { ConflictError, InvalidConfigError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runOperation } from "./operation.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";
import { toValidationIssue } from "./validation.ts";

export const SCHEMA_FORMAT_VERSION = "2";

/**
 * Runtime budgets for one `createIndex` call. These shape how long the call
 * may wait or run; nothing here is persisted or affects the resulting index.
 */
export interface CreateIndexOptions {
  /**
   * How long to wait for the database-wide provisioning lock that serializes
   * concurrent `createIndex` calls (and the extension installs they may
   * perform) before throwing {@link LockTimeoutError}. `0` waits indefinitely.
   * Default: 30 000 (30 s).
   */
  readonly lockTimeoutMs?: number;
  /**
   * Wall-clock budget for the whole provisioning transaction — extension
   * installs, DDL, routines — before throwing {@link TransactionTimeoutError}.
   * `0` disables the limit. Default: 1 200 000 (20 min).
   */
  readonly transactionTimeoutMs?: number;
}

const createIndexOptionsSchema = z.strictObject({
  lockTimeoutMs: z.int().nonnegative().optional(),
  transactionTimeoutMs: z.int().nonnegative().optional(),
});

function normalizeCreateIndexOptions(input: unknown): {
  readonly lockTimeout: string;
  readonly transactionTimeout: string;
} {
  const result = createIndexOptionsSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "options"}: ${first.message}`
      : "validation failed";
    throw new InvalidConfigError(`Invalid createIndex options: ${detail}`, {
      cause: result.error,
      issues,
    });
  }
  const { lockTimeoutMs, transactionTimeoutMs } = result.data;
  return {
    lockTimeout:
      lockTimeoutMs === undefined
        ? DEFAULT_MIGRATION_LOCK_TIMEOUT
        : `${lockTimeoutMs}ms`,
    transactionTimeout:
      transactionTimeoutMs === undefined
        ? DEFAULT_MIGRATION_TIMEOUTS.transactionTimeout
        : `${transactionTimeoutMs}ms`,
  };
}

/**
 * Create a new immutable index schema. Rebuilding into a new schema is the
 * upgrade path; this operation never mutates or migrates an existing schema.
 */
export async function createIndex(
  sql: postgres.Sql,
  schema: string,
  config: IndexConfig,
  options?: CreateIndexOptions,
): Promise<void> {
  return runOperation("searchgres.index.create", { schema }, async (span) => {
    const indexSchema = assertSchemaName(schema);
    const creation = normalizeIndexConfig(config);
    const budgets = normalizeCreateIndexOptions(options);
    span.setAttributes({
      "searchgres.index.vector_type": creation.vectorType,
      "searchgres.index.dimensions": creation.dimensions,
    });

    await createIndexSchema(sql, indexSchema, creation, budgets);
  });
}

async function createIndexSchema(
  sql: postgres.Sql,
  indexSchema: string,
  creation: ReturnType<typeof normalizeIndexConfig>,
  budgets: ReturnType<typeof normalizeCreateIndexOptions>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await applySessionTimeouts(tx, {
      ...DEFAULT_MIGRATION_TIMEOUTS,
      lockTimeout: budgets.lockTimeout,
      transactionTimeout: budgets.transactionTimeout,
    });
    await acquireAdvisoryLock(tx, CREATE_INDEX_LOCK_KEY);
    await setLockTimeout(tx, DEFAULT_MIGRATION_TIMEOUTS.lockTimeout);
    await ensurePostgresVersion(tx);

    const [existing] = await runSql(
      tx<{ readonly present: boolean }[]>`
        select exists
        (
          select 1
          from pg_catalog.pg_namespace n
          where n.nspname = ${indexSchema}
        ) as present
      `,
      { spanName: "schemaExists", dbOperationName: "SELECT" },
    );
    if (existing?.present) {
      throw new ConflictError(
        `Index schema ${JSON.stringify(indexSchema)} already exists`,
      );
    }

    // searchgres is public-only: every required extension is installed in and
    // resolved from `public`, so all extension objects are qualified as such.
    for (const requirement of REQUIRED_EXTENSIONS) {
      await ensureExtension(tx, requirement);
    }

    // ------------------------------------------------------------------------
    // validate text search configuration
    // ------------------------------------------------------------------------
    let textConfig: { readonly literal: string } | undefined;
    try {
      [textConfig] = await runSql(
        tx<{ readonly literal: string }[]>`
          select pg_catalog.quote_literal(c.oid::pg_catalog.regconfig::text) as literal
          from pg_catalog.pg_ts_config c
          where c.oid = ${creation.bm25.textConfig}::pg_catalog.regconfig
        `,
        { spanName: "validateTextConfig", dbOperationName: "SELECT" },
      );
    } catch (error) {
      if (postgresErrorCode(error) !== "42704") {
        throw error;
      }
    }
    if (!textConfig) {
      throw new InvalidConfigError(
        `Unknown text search configuration: ${creation.bm25.textConfig}`,
        {
          issues: [
            {
              code: "custom",
              message: "must name an installed text search configuration",
              path: ["bm25", "textConfig"],
            },
          ],
        },
      );
    }

    const context = indexSqlContext(indexSchema, creation, textConfig.literal);
    await executeDefinitions(tx, context, schemaDefinitions);
    // Transaction-local only; retain the original provisioning resolution context.
    await runSql(tx`set local search_path to pg_catalog, public, pg_temp`, {
      spanName: "setLocalSearchPath",
      dbOperationName: "SET",
      namespace: indexSchema,
    });
    await executeDefinitions(tx, context, indexDefinitions);

    // ------------------------------------------------------------------------
    // record the schema format marker
    // ------------------------------------------------------------------------
    await runSql(
      tx`
        insert into ${tx(indexSchema)}.version (version)
        values (${SCHEMA_FORMAT_VERSION})
      `,
      {
        spanName: "recordSchemaVersion",
        dbOperationName: "INSERT",
        namespace: indexSchema,
      },
    );
  });
}
