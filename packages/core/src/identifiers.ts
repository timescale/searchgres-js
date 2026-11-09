import { z } from "zod";
import { InvalidConfigError, TreePathError } from "./errors.ts";
import { toValidationIssue } from "./validation.ts";

/** PostgreSQL's maximum identifier length at the default NAMEDATALEN (64). */
export const MAX_IDENTIFIER_LENGTH = 63;

/**
 * Deliberately narrower than quoted PostgreSQL identifiers.
 *
 * searchgres accepts the literal schema name (it does not add a prefix), but a
 * lowercase unquoted-style identifier keeps logs, catalog lookups, and manual
 * SQL unsurprising. postgres.js still escapes it with `sql(name)` at every use;
 * validation is for a clear boundary error, not as a substitute for escaping.
 */
const schemaNameSchema = z
  .string()
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[a-z_][a-z0-9_]*$/);

/** PostgreSQL 16+ ltree labels: letters, digits, underscore, and hyphen. */
const treePathSchema = z
  .string()
  .refine(
    (path) =>
      path === "" ||
      path.split(".").every((label) => /^[A-Za-z0-9_-]+$/.test(label)),
    "expected dot-separated ltree labels matching [A-Za-z0-9_-]+ (or an empty string for the root)",
  );

/** Whether `schema` is a lowercase PostgreSQL identifier of at most 63 bytes. */
export function isValidSchemaName(schema: string): boolean {
  return schemaNameSchema.safeParse(schema).success;
}

/** Validate and return a caller-supplied literal schema name. */
export function assertSchemaName(schema: string): string {
  const result = schemaNameSchema.safeParse(schema);
  if (!result.success) {
    throw new InvalidConfigError(
      `Invalid schema name ${JSON.stringify(schema)}: expected a lowercase PostgreSQL identifier matching [a-z_][a-z0-9_]* and at most ${MAX_IDENTIFIER_LENGTH} characters`,
      {
        cause: result.error,
        issues: result.error.issues.map(toValidationIssue),
      },
    );
  }
  return result.data;
}

/** Whether `path` is a concrete dotted ltree path (the empty root is valid). */
export function isValidTreePath(path: string): boolean {
  return treePathSchema.safeParse(path).success;
}

/** Validate and return a concrete dotted ltree path. */
export function assertTreePath(path: string): string {
  const result = treePathSchema.safeParse(path);
  if (!result.success) {
    throw new TreePathError(
      path,
      `Invalid tree path ${JSON.stringify(path)}: ${result.error.issues[0]?.message ?? "invalid ltree path"}`,
      { cause: result.error },
    );
  }
  return result.data;
}
