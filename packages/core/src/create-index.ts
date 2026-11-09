import type postgres from "postgres";
import { type IndexConfig, normalizeIndexConfig } from "./config.ts";
import { bootstrapMigrations, executeMigrations } from "./db/definitions.ts";
import {
  assertPrismPgvectorCompat,
  extensionsForVectorIndex,
  getExtensionInfo,
} from "./db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "./db/lock.ts";
import { ensurePostgresVersion } from "./db/preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_TIMEOUTS,
  setLockTimeout,
} from "./db/session.ts";
import { indexSqlContext } from "./db/template.ts";
import { ConflictError, InvalidConfigError } from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import {
  normalizeMigrationOptions,
  runIndexMigrations,
} from "./migrate-index.ts";
import { runOperation } from "./operation.ts";
import { postgresErrorCode } from "./sql/errors.ts";
import { runSql } from "./sql/exec.ts";

export const SCHEMA_FORMAT_VERSION = "3";

/**
 * Runtime budgets for one `createIndex` call. These shape how long the call
 * may wait or run; nothing here is persisted or affects the resulting index.
 */
export interface CreateIndexOptions {
  /**
   * How long to wait for the per-schema lock that serializes concurrent
   * `createIndex` and `migrateIndex` calls targeting this schema before
   * throwing {@link LockTimeoutError}. `0` waits indefinitely.
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

/**
 * Create a new index schema at the current schema format version (`3`).
 * Existing schemas are rejected; use {@link migrateIndex} to upgrade an
 * existing index in place.
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
    const budgets = normalizeMigrationOptions(options, "createIndex");
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
  budgets: ReturnType<typeof normalizeMigrationOptions>,
): Promise<void> {
  await sql.begin(async (tx) => {
    await applySessionTimeouts(tx, {
      ...DEFAULT_MIGRATION_TIMEOUTS,
      lockTimeout: budgets.lockTimeout,
      transactionTimeout: budgets.transactionTimeout,
    });
    await acquireAdvisoryLock(tx, advisoryLockKey(indexSchema));
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
        `Schema ${JSON.stringify(indexSchema)} already exists. createIndex creates a new schema for each index; use openIndex for an existing index`,
      );
    }

    // searchgres is public-only: every required extension must be installed in
    // `public` (via `ensureExtensions` or administrative setup).
    for (const requirement of extensionsForVectorIndex(
      creation.vectorIndex.method,
    )) {
      await getExtensionInfo(tx, requirement);
    }
    if (creation.vectorIndex.method === "prism") {
      await assertPrismPgvectorCompat(tx, creation.vectorType);
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
    // Transaction-local only; retain the original provisioning resolution context.
    await runSql(tx`set local search_path to pg_catalog, public, pg_temp`, {
      spanName: "setLocalSearchPath",
      dbOperationName: "SET",
      namespace: indexSchema,
    });
    await executeMigrations(
      tx,
      context,
      bootstrapMigrations,
      SCHEMA_FORMAT_VERSION,
    );
    await runIndexMigrations(tx, context, "fresh");
  });
}
