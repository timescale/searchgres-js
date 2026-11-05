/// <reference path="../sql.d.ts" />
import type postgres from "postgres";
import { runSql } from "../sql/exec.ts";
import provisionSql from "./sql/bootstrap/001_provision.sql" with {
  type: "text",
};
import migrationTableSql from "./sql/bootstrap/002_migration.sql" with {
  type: "text",
};
import idempotent001Triggers from "./sql/idempotent/001_triggers.sql" with {
  type: "text",
};
import idempotent002Records from "./sql/idempotent/002_records.sql" with {
  type: "text",
};
import idempotent003Tree from "./sql/idempotent/003_tree.sql" with {
  type: "text",
};
import idempotent004Search from "./sql/idempotent/004_search.sql" with {
  type: "text",
};
import idempotent005EmbeddingQueue from "./sql/idempotent/005_embedding_queue.sql" with {
  type: "text",
};
import incremental001Initial from "./sql/incremental/001_initial.sql" with {
  type: "text",
};
import { type IndexSqlContext, renderSql } from "./template.ts";

export type MigrationFileType = "bootstrap" | "incremental" | "idempotent";

export interface Migration {
  readonly name: string;
  readonly file: string;
  readonly type: MigrationFileType;
  readonly sql: string;
}

/** Derive a migration name from its numbered relative SQL file path. */
export function migrationNameFromFile(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1);
  if (!base.endsWith(".sql")) {
    throw new Error(`Migration file must end with .sql: ${file}`);
  }
  const name = base.slice(0, -4);
  if (!/^\d{3}_[a-z0-9_]+$/.test(name)) {
    throw new Error(
      `Migration file name must use a 3-digit prefix (NNN_name.sql): ${file}`,
    );
  }
  return name;
}

export function defineMigration(
  type: MigrationFileType,
  file: string,
  sql: string,
): Migration {
  return Object.freeze({
    name: migrationNameFromFile(file),
    file,
    type,
    sql,
  });
}

function sortByName(migrations: readonly Migration[]): readonly Migration[] {
  return Object.freeze(
    [...migrations].sort((a, b) => a.name.localeCompare(b.name)),
  );
}

export const provisionMigration: Migration = defineMigration(
  "bootstrap",
  "bootstrap/001_provision.sql",
  provisionSql,
);

export const migrationTableMigration: Migration = defineMigration(
  "bootstrap",
  "bootstrap/002_migration.sql",
  migrationTableSql,
);

export const bootstrapMigrations: readonly Migration[] = sortByName([
  provisionMigration,
  migrationTableMigration,
]);

export const incrementalMigrations: readonly Migration[] = sortByName([
  defineMigration(
    "incremental",
    "incremental/001_initial.sql",
    incremental001Initial,
  ),
]);

export const idempotentMigrations: readonly Migration[] = sortByName([
  defineMigration(
    "idempotent",
    "idempotent/001_triggers.sql",
    idempotent001Triggers,
  ),
  defineMigration(
    "idempotent",
    "idempotent/002_records.sql",
    idempotent002Records,
  ),
  defineMigration("idempotent", "idempotent/003_tree.sql", idempotent003Tree),
  defineMigration(
    "idempotent",
    "idempotent/004_search.sql",
    idempotent004Search,
  ),
  defineMigration(
    "idempotent",
    "idempotent/005_embedding_queue.sql",
    idempotent005EmbeddingQueue,
  ),
]);

export async function executeMigrations(
  tx: postgres.TransactionSql,
  context: IndexSqlContext,
  migrations: readonly Migration[],
  schemaVersion: string,
): Promise<void> {
  const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));
  for (const migration of ordered) {
    await executeMigrationFile(tx, context, migration, schemaVersion);
  }
}

export async function executeMigrationFile(
  tx: postgres.TransactionSql,
  context: IndexSqlContext,
  migration: Migration,
  schemaVersion: string,
): Promise<void> {
  const rendered = renderSql(migration.sql, context.variables);
  await runSql(tx.unsafe(rendered), {
    spanName: `${migration.type}:${migration.name}`,
    dbOperationName: "CREATE",
    namespace: context.schema,
    attributes: {
      "searchgres.migration.name": migration.name,
      "searchgres.migration.file": migration.file,
      "searchgres.migration.type": migration.type,
      "searchgres.migration.schema_version": schemaVersion,
    },
  });
}
