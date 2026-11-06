import type postgres from "postgres";
import { z } from "zod";
import { SCHEMA_FORMAT_VERSION } from "./create-index.ts";
import {
  executeMigrationFile,
  executeMigrations,
  idempotentMigrations,
  incrementalMigrations,
  type Migration,
  migrationTableMigration,
} from "./db/definitions.ts";
import {
  getExtensionInfo,
  PRISM_EXTENSION_REQUIREMENT,
  REQUIRED_EXTENSIONS,
} from "./db/extensions.ts";
import { acquireAdvisoryLock, advisoryLockKey } from "./db/lock.ts";
import {
  readIndexMarker,
  readIndexShape,
  readMigrationLedgerState,
} from "./db/marker.ts";
import { ensurePostgresVersion } from "./db/preflight.ts";
import {
  applySessionTimeouts,
  DEFAULT_MIGRATION_LOCK_TIMEOUT,
  DEFAULT_MIGRATION_TIMEOUTS,
  setLockTimeout,
} from "./db/session.ts";
import {
  type IndexSqlContext,
  migrationSqlContext,
  type StoredIndexShape,
} from "./db/template.ts";
import {
  InvalidConfigError,
  InvalidIndexError,
  MINIMUM_MIGRATABLE_SCHEMA_VERSION,
  parseSchemaVersion,
  SchemaVersionError,
} from "./errors.ts";
import { assertSchemaName } from "./identifiers.ts";
import { runOperation } from "./operation.ts";
import { runSql } from "./sql/exec.ts";
import { toValidationIssue } from "./validation.ts";

export { MINIMUM_MIGRATABLE_SCHEMA_VERSION } from "./errors.ts";

const BASELINE_MIGRATION_NAME = "001_initial";

/**
 * Runtime budgets for one `migrateIndex` call. These shape how long the call
 * may wait or run; nothing here is persisted or affects the resulting index.
 */
export interface MigrateIndexOptions {
  /**
   * How long to wait for the per-index migration lock that serializes
   * cooperating `migrateIndex` calls targeting the same schema before throwing
   * {@link LockTimeoutError}. `0` waits indefinitely. Default: 30 000 (30 s).
   */
  readonly lockTimeoutMs?: number;
  /**
   * Wall-clock budget for the whole migration transaction before throwing
   * {@link TransactionTimeoutError}. `0` disables the limit.
   * Default: 1 200 000 (20 min).
   */
  readonly transactionTimeoutMs?: number;
}

/** Summary of one completed {@link migrateIndex} run. */
export interface MigrateIndexResult {
  readonly schema: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly applied: readonly string[];
}

const migrationOptionsSchema = z.strictObject({
  lockTimeoutMs: z.int().nonnegative().optional(),
  transactionTimeoutMs: z.int().nonnegative().optional(),
});

/** @internal Shared option normalizer for `createIndex`, `migrateIndex`, and `ensureExtensions`. */
export function normalizeMigrationOptions(
  input: unknown,
  operationName: "createIndex" | "migrateIndex" | "ensureExtensions",
): {
  readonly lockTimeout: string;
  readonly transactionTimeout: string;
} {
  const result = migrationOptionsSchema.safeParse(input ?? {});
  if (!result.success) {
    const issues = result.error.issues.map(toValidationIssue);
    const first = issues[0];
    const detail = first
      ? `${first.path.join(".") || "options"}: ${first.message}`
      : "validation failed";
    throw new InvalidConfigError(
      `Invalid ${operationName} options: ${detail}`,
      {
        cause: result.error,
        issues,
      },
    );
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
 * Explicitly migrate an existing searchgres index in place to the current
 * schema format version (`3`). Accepts starting schema versions `2` and `3`;
 * version `1` and newer versions are rejected with {@link SchemaVersionError}.
 */
export async function migrateIndex(
  sql: postgres.Sql,
  schema: string,
  options?: MigrateIndexOptions,
): Promise<MigrateIndexResult> {
  return runOperation("searchgres.index.migrate", { schema }, async (span) => {
    const indexSchema = assertSchemaName(schema);
    const budgets = normalizeMigrationOptions(options, "migrateIndex");
    const { shape, result } = await migrateIndexSchema(
      sql,
      indexSchema,
      budgets,
    );
    span.setAttributes({
      "searchgres.index.vector_type": shape.vectorType,
      "searchgres.index.dimensions": shape.dimensions,
    });
    return result;
  });
}

/** @internal Shared migration runner used by `createIndex` and `migrateIndex`. */
export async function runIndexMigrations(
  tx: postgres.TransactionSql,
  context: IndexSqlContext,
  mode: "fresh" | "existing",
  migrations: readonly Migration[] = incrementalMigrations,
  idempotents: readonly Migration[] = idempotentMigrations,
): Promise<readonly string[]> {
  const rows = await runSql(
    tx<{ readonly name: string }[]>`
      select name
      from ${tx(context.schema)}.migration
    `,
    {
      spanName: "readAppliedMigrations",
      dbOperationName: "SELECT",
      namespace: context.schema,
    },
  );
  const alreadyApplied = new Set<string>(rows.map((row) => row.name));

  const orderedIncrementals = [...migrations].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const newlyApplied: string[] = [];
  for (const migration of orderedIncrementals) {
    if (alreadyApplied.has(migration.name)) {
      continue;
    }
    await executeMigrationFile(tx, context, migration, SCHEMA_FORMAT_VERSION);
    await recordAppliedMigration(
      tx,
      context.schema,
      migration.name,
      SCHEMA_FORMAT_VERSION,
    );
    newlyApplied.push(migration.name);
  }

  await executeMigrations(tx, context, idempotents, SCHEMA_FORMAT_VERSION);

  if (mode === "fresh") {
    await runSql(
      tx`
        insert into ${tx(context.schema)}.version (version)
        values (${SCHEMA_FORMAT_VERSION})
      `,
      {
        spanName: "recordSchemaVersion",
        dbOperationName: "INSERT",
        namespace: context.schema,
      },
    );
  } else {
    await runSql(
      tx`
        update ${tx(context.schema)}.version set
          version = ${SCHEMA_FORMAT_VERSION}
        , at = pg_catalog.now()
      `,
      {
        spanName: "updateSchemaVersion",
        dbOperationName: "UPDATE",
        namespace: context.schema,
      },
    );
  }
  return Object.freeze(newlyApplied);
}

/** @internal Record one applied incremental migration in `<schema>.migration`. */
export async function recordAppliedMigration(
  tx: postgres.TransactionSql,
  schema: string,
  name: string,
  appliedAtVersion: string,
): Promise<void> {
  await runSql(
    tx`
      insert into ${tx(schema)}.migration (name, applied_at_version)
      values (${name}, ${appliedAtVersion})
    `,
    {
      spanName: "recordAppliedMigration",
      dbOperationName: "INSERT",
      namespace: schema,
    },
  );
}

async function migrateIndexSchema(
  sql: postgres.Sql,
  indexSchema: string,
  budgets: ReturnType<typeof normalizeMigrationOptions>,
): Promise<{
  readonly shape: StoredIndexShape;
  readonly result: MigrateIndexResult;
}> {
  return sql.begin("isolation level read committed", async (tx) => {
    await applySessionTimeouts(tx, {
      ...DEFAULT_MIGRATION_TIMEOUTS,
      lockTimeout: budgets.lockTimeout,
      transactionTimeout: budgets.transactionTimeout,
    });
    await acquireAdvisoryLock(tx, advisoryLockKey(indexSchema));
    await setLockTimeout(tx, DEFAULT_MIGRATION_TIMEOUTS.lockTimeout);
    await runSql(tx`set local search_path to pg_catalog, public, pg_temp`, {
      spanName: "setLocalSearchPath",
      dbOperationName: "SET",
      namespace: indexSchema,
    });
    await ensurePostgresVersion(tx);

    const version = await readIndexMarker(tx, indexSchema);
    const parsedVersion = parseSchemaVersion(version);
    const minVersion = BigInt(MINIMUM_MIGRATABLE_SCHEMA_VERSION);
    const targetVersion = BigInt(SCHEMA_FORMAT_VERSION);
    if (
      parsedVersion === null ||
      parsedVersion < minVersion ||
      parsedVersion > targetVersion
    ) {
      throw new SchemaVersionError(indexSchema, version, SCHEMA_FORMAT_VERSION);
    }

    const ledger = await readMigrationLedgerState(tx, indexSchema);
    if (version === MINIMUM_MIGRATABLE_SCHEMA_VERSION) {
      if (ledger.relkind !== null) {
        throw new InvalidIndexError(indexSchema, {
          detail: `unexpected migration relation present on schema format ${version}`,
        });
      }
    } else if (!ledger.validTable) {
      throw new InvalidIndexError(indexSchema, {
        detail: `missing or invalid migration table for schema format ${version}`,
      });
    }

    if (!ledger.isOwner) {
      await runSql(
        tx`
          do $ownership$
          begin
            raise exception 'only the schema owner can migrate a searchgres index'
              using errcode = 'insufficient_privilege';
          end;
          $ownership$
        `,
        {
          spanName: "assertIndexSchemaOwner",
          dbOperationName: "DO",
          namespace: indexSchema,
        },
      );
    }

    for (const requirement of REQUIRED_EXTENSIONS) {
      await getExtensionInfo(tx, requirement);
    }

    const vectorShape = await readIndexShape(tx, indexSchema);
    if (vectorShape.vectorIndex === "prism") {
      await getExtensionInfo(tx, PRISM_EXTENSION_REQUIREMENT);
    }
    const context = migrationSqlContext(indexSchema, vectorShape);

    if (version === MINIMUM_MIGRATABLE_SCHEMA_VERSION) {
      const baseline = incrementalMigrations.find(
        (migration) => migration.name === BASELINE_MIGRATION_NAME,
      );
      if (!baseline) {
        throw new Error(
          `Missing baseline incremental migration ${BASELINE_MIGRATION_NAME}`,
        );
      }
      await executeMigrationFile(
        tx,
        context,
        migrationTableMigration,
        SCHEMA_FORMAT_VERSION,
      );
      await recordAppliedMigration(
        tx,
        indexSchema,
        baseline.name,
        MINIMUM_MIGRATABLE_SCHEMA_VERSION,
      );
    }

    const applied = await runIndexMigrations(tx, context, "existing");
    return {
      shape: vectorShape,
      result: Object.freeze({
        schema: indexSchema,
        fromVersion: version,
        toVersion: SCHEMA_FORMAT_VERSION,
        applied,
      }),
    };
  });
}
