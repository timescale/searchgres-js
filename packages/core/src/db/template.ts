import {
  type IndexConfig,
  MAX_PRISM_DIMENSIONS,
  MAX_VECTOR_DIMENSIONS,
  normalizeIndexConfig,
  type VectorIndexMethod,
} from "../config.ts";
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
  "vector_index_ident",
  "vector_index_literal",
  "vector_index_am_ident",
  "cosine_opclass_ident",
  "vector_index_with_clause",
  "text_config_literal",
  "bm25_k1_number",
  "bm25_b_number",
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
  readonly vectorIndex?: VectorIndexMethod;
}

export function vectorIndexNameForMethod(method: VectorIndexMethod): string {
  return method === "prism"
    ? "record_embedding_prism_idx"
    : "record_embedding_hnsw_idx";
}

export function cosineOpclassForShape(
  vectorType: "vector" | "halfvec",
  method: VectorIndexMethod,
): string {
  if (method === "prism") {
    return vectorType === "vector" ? "vec32_cosine_ops" : "vec16_cosine_ops";
  }
  return `${vectorType}_cosine_ops`;
}

/** One closed context for provisioning. Record data never enters templates. */
export function indexSqlContext(
  schema: string,
  config: IndexConfig,
  textConfigLiteral: string,
): IndexSqlContext {
  const name = assertSchemaName(schema);
  const normalized = normalizeIndexConfig(config);
  const method = normalized.vectorIndex.method;
  const vectorIndexIdent = sqlIdentifier(vectorIndexNameForMethod(method));
  const vectorIndexAmIdent = sqlIdentifier(method);
  const cosineOpclassIdent = sqlIdentifier(
    cosineOpclassForShape(normalized.vectorType, method),
  );

  let vectorIndexWithClause: SqlFragment;
  if (normalized.vectorIndex.method === "hnsw") {
    const m = sqlNumber(normalized.vectorIndex.m, true);
    const ef = sqlNumber(normalized.vectorIndex.efConstruction, true);
    vectorIndexWithClause = trusted(
      `\nwith\n( m = ${m.text}\n, ef_construction = ${ef.text}\n)`,
    );
  } else {
    const prismOpts: string[] = [];
    if (normalized.vectorIndex.nlist !== undefined) {
      prismOpts.push(
        `nlist = ${sqlNumber(normalized.vectorIndex.nlist, true).text}`,
      );
    }
    if (normalized.vectorIndex.targetPages !== undefined) {
      prismOpts.push(
        `target_pages = ${sqlNumber(normalized.vectorIndex.targetPages, true).text}`,
      );
    }
    vectorIndexWithClause =
      prismOpts.length === 0
        ? trusted("")
        : trusted(`\nwith\n( ${prismOpts.join("\n, ")}\n)`);
  }

  return Object.freeze({
    schema: name,
    variables: Object.freeze({
      schema_ident: sqlIdentifier(name),
      schema_comment_literal: sqlLiteral(INDEX_SCHEMA_COMMENT),
      vector_type_ident: sqlIdentifier(normalized.vectorType),
      dimensions_int: sqlNumber(normalized.dimensions, true),
      vector_index_ident: vectorIndexIdent,
      vector_index_literal: sqlLiteral(
        `${name}.${vectorIndexNameForMethod(method)}`,
      ),
      vector_index_am_ident: vectorIndexAmIdent,
      cosine_opclass_ident: cosineOpclassIdent,
      vector_index_with_clause: vectorIndexWithClause,
      text_config_literal: catalogLiteral(textConfigLiteral),
      bm25_k1_number: sqlNumber(normalized.bm25.k1),
      bm25_b_number: sqlNumber(normalized.bm25.b),
      bm25_index_literal: sqlLiteral(`${name}.record_content_bm25_idx`),
    }),
  });
}

/**
 * Context for migrating an existing index using its stored vector shape.
 * Omits creation-only BM25/HNSW/PRISM parameters so migrations and repeatable
 * SQL cannot silently fall back to creation defaults.
 */
export function migrationSqlContext(
  schema: string,
  shape: StoredIndexShape,
): IndexSqlContext {
  const name = assertSchemaName(schema);
  if (shape.vectorType !== "vector" && shape.vectorType !== "halfvec") {
    throw new Error(`Invalid vector type: ${String(shape.vectorType)}`);
  }
  const method: VectorIndexMethod = shape.vectorIndex ?? "hnsw";
  if (method !== "hnsw" && method !== "prism") {
    throw new Error(`Invalid vector index method: ${String(method)}`);
  }
  const maxDimensions =
    method === "prism"
      ? MAX_PRISM_DIMENSIONS
      : MAX_VECTOR_DIMENSIONS[shape.vectorType];
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
      vector_index_ident: sqlIdentifier(vectorIndexNameForMethod(method)),
      vector_index_literal: sqlLiteral(
        `${name}.${vectorIndexNameForMethod(method)}`,
      ),
      vector_index_am_ident: sqlIdentifier(method),
      cosine_opclass_ident: sqlIdentifier(
        cosineOpclassForShape(shape.vectorType, method),
      ),
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
