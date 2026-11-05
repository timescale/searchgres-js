import { type IndexConfig, normalizeIndexConfig } from "../config.ts";
import { assertSchemaName } from "../identifiers.ts";
import { INDEX_SCHEMA_COMMENT } from "./marker.ts";

const fragment = Symbol("SQL definition fragment");
interface SqlFragment {
  readonly [fragment]: true;
  readonly text: string;
}

const variableNames = [
  "schema_ident",
  "schema_comment_literal",
  "vector_type_ident",
  "dimensions_int",
  "cosine_opclass_ident",
  "text_config_literal",
  "bm25_k1_number",
  "bm25_b_number",
  "hnsw_m_int",
  "hnsw_ef_construction_int",
  "bm25_index_literal",
] as const;
type VariableName = (typeof variableNames)[number];
export type TemplateVariables = Readonly<
  Partial<Record<VariableName, SqlFragment>>
>;
const allowedNames: ReadonlySet<string> = new Set(variableNames);

function trusted(text: string): SqlFragment {
  return Object.freeze({ [fragment]: true as const, text });
}

export function sqlIdentifier(value: string): SqlFragment {
  if (!value || value.includes("\0")) throw new Error("Invalid SQL identifier");
  return trusted(`"${value.replaceAll('"', '""')}"`);
}

export function sqlLiteral(value: string): SqlFragment {
  if (value.includes("\0")) throw new Error("Invalid SQL literal");
  const escaped = value.replaceAll("'", "''");
  // E strings make backslashes safe even if standard_conforming_strings is off.
  return trusted(
    value.includes("\\")
      ? `E'${escaped.replaceAll("\\", "\\\\")}'`
      : `'${escaped}'`,
  );
}

export function sqlNumber(value: number, integer = false): SqlFragment {
  if (!Number.isFinite(value) || (integer && !Number.isSafeInteger(value))) {
    throw new Error("Invalid SQL number");
  }
  return trusted(String(value));
}

/** Only accepts the output of pg_catalog.quote_literal, never caller SQL. */
function catalogLiteral(value: string): SqlFragment {
  if (
    value.includes("\0") ||
    !/^(?:'(?:[^'\\]|'')*'|E'(?:[^'\\]|\\[\s\S]|'')*')$/.test(value)
  ) {
    throw new Error("Invalid catalog SQL literal");
  }
  return trusted(value);
}

export interface IndexSqlContext {
  readonly schema: string;
  readonly variables: TemplateVariables;
}

export interface StoredIndexShape {
  readonly vectorType: "vector" | "halfvec";
  readonly dimensions: number;
}

/** One closed context for provisioning. Record data never enters templates. */
export function indexSqlContext(
  schema: string,
  config: IndexConfig,
  textConfigLiteral: string,
): IndexSqlContext {
  const name = assertSchemaName(schema);
  const normalized = normalizeIndexConfig(config);
  return Object.freeze({
    schema: name,
    variables: Object.freeze({
      schema_ident: sqlIdentifier(name),
      schema_comment_literal: sqlLiteral(INDEX_SCHEMA_COMMENT),
      vector_type_ident: sqlIdentifier(normalized.vectorType),
      dimensions_int: sqlNumber(normalized.dimensions, true),
      cosine_opclass_ident: sqlIdentifier(
        `${normalized.vectorType}_cosine_ops`,
      ),
      text_config_literal: catalogLiteral(textConfigLiteral),
      bm25_k1_number: sqlNumber(normalized.bm25.k1),
      bm25_b_number: sqlNumber(normalized.bm25.b),
      hnsw_m_int: sqlNumber(normalized.hnsw.m, true),
      hnsw_ef_construction_int: sqlNumber(normalized.hnsw.efConstruction, true),
      bm25_index_literal: sqlLiteral(`${name}.record_content_bm25_idx`),
    }),
  });
}

/**
 * Context for migrating an existing index using its stored vector shape.
 * Omits creation-only BM25/HNSW parameters so migrations and repeatable SQL
 * cannot silently fall back to creation defaults.
 */
export function migrationSqlContext(
  schema: string,
  shape: StoredIndexShape,
): IndexSqlContext {
  const name = assertSchemaName(schema);
  if (shape.vectorType !== "vector" && shape.vectorType !== "halfvec") {
    throw new Error(`Invalid vector type: ${String(shape.vectorType)}`);
  }
  const maxDimensions = shape.vectorType === "vector" ? 2000 : 4000;
  if (
    !Number.isSafeInteger(shape.dimensions) ||
    shape.dimensions < 1 ||
    shape.dimensions > maxDimensions
  ) {
    throw new Error(`Invalid vector dimensions: ${String(shape.dimensions)}`);
  }
  return Object.freeze({
    schema: name,
    variables: Object.freeze({
      schema_ident: sqlIdentifier(name),
      schema_comment_literal: sqlLiteral(INDEX_SCHEMA_COMMENT),
      vector_type_ident: sqlIdentifier(shape.vectorType),
      dimensions_int: sqlNumber(shape.dimensions, true),
      cosine_opclass_ident: sqlIdentifier(`${shape.vectorType}_cosine_ops`),
      bm25_index_literal: sqlLiteral(`${name}.record_content_bm25_idx`),
    }),
  });
}

/** Memory Engine-style names, but no expressions, directives or recursion. */
export function renderSql(sql: string, variables: TemplateVariables): string {
  return sql.replace(
    /\{\{([^{}]*)\}\}|\{\{|\}\}/g,
    (token: string, name?: string) => {
      if (!name || !allowedNames.has(name) || !Object.hasOwn(variables, name)) {
        throw new Error(`Invalid or missing SQL template variable: ${token}`);
      }
      const value = variables[name as VariableName];
      if (value?.[fragment] !== true) {
        throw new Error("SQL template values must be prepared fragments");
      }
      return value.text;
    },
  );
}
