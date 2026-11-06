import type postgres from "postgres";
import {
  MAX_PRISM_DIMENSIONS,
  MAX_VECTOR_DIMENSIONS,
  type VectorIndexMethod,
} from "../config.ts";
import { InvalidIndexError } from "../errors.ts";
import { runSql } from "../sql/exec.ts";
import { cosineOpclassForShape, type StoredIndexShape } from "./template.ts";

/**
 * Comment stamped on every index schema by `createIndex`. It is the first
 * thing `openIndex`/`dropIndex` check, so a caller schema that merely happens
 * to contain a table named `version` is never mistaken for an index.
 */
export const INDEX_SCHEMA_COMMENT = "searchgres index";

/**
 * `INDEX_SCHEMA_COMMENT` as a single-quoted SQL literal for `COMMENT ON`,
 * which is a utility statement and cannot take bind parameters. The constant
 * contains no quote characters, so simple wrapping is a faithful literal.
 */
export const INDEX_SCHEMA_COMMENT_LITERAL = `'${INDEX_SCHEMA_COMMENT.replaceAll("'", "''")}'`;

interface MarkerRow {
  readonly schema_comment: string | null;
  readonly has_version_table: boolean;
  readonly has_version_column: boolean;
  readonly has_record_table: boolean;
  readonly has_queue_table: boolean;
}

interface VersionRow {
  readonly version: string;
}

/**
 * Verify that `schema` is a searchgres index and return its schema-format
 * version. Requires the `createIndex` schema comment, the `version`, `record`,
 * and `embedding_queue` tables, and exactly one non-empty `version` row.
 *
 * Any format version is accepted here; callers decide whether the format is
 * one they support (`openIndex`) or irrelevant (`dropIndex`, which must remain
 * able to remove obsolete indexes).
 */
export async function readIndexMarker(
  sql: postgres.ISql,
  schema: string,
): Promise<string> {
  const [marker] = await runSql(
    sql<MarkerRow[]>`
      select
        pg_catalog.obj_description(n.oid, 'pg_namespace') as schema_comment
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'version'
          and c.relkind = 'r'
        ) as has_version_table
      , exists (
          select 1
          from pg_catalog.pg_attribute a
          inner join pg_catalog.pg_class c on (c.oid = a.attrelid)
          where c.relnamespace = n.oid
          and c.relname = 'version'
          and c.relkind = 'r'
          and a.attname = 'version'
          and a.attnum > 0
          and not a.attisdropped
          and a.atttypid in (
            'pg_catalog.int8'::pg_catalog.regtype
          , 'pg_catalog.text'::pg_catalog.regtype
          )
        ) as has_version_column
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'record'
          and c.relkind = 'r'
        ) as has_record_table
      , exists (
          select 1
          from pg_catalog.pg_class c
          where c.relnamespace = n.oid
          and c.relname = 'embedding_queue'
          and c.relkind = 'r'
        ) as has_queue_table
      from pg_catalog.pg_namespace n
      where n.nspname = ${schema}
    `,
    { spanName: "readIndexMarker", dbOperationName: "SELECT" },
  );
  if (
    !marker ||
    marker.schema_comment !== INDEX_SCHEMA_COMMENT ||
    !marker.has_version_table ||
    !marker.has_version_column ||
    !marker.has_record_table ||
    !marker.has_queue_table
  ) {
    throw new InvalidIndexError(schema);
  }

  const rows = await runSql(
    sql<VersionRow[]>`
      select version::text as version
      from ${sql(schema)}.version
    `,
    {
      spanName: "readSchemaVersion",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  const version = rows.length === 1 ? rows[0]?.version : undefined;
  if (typeof version !== "string" || version.length === 0) {
    throw new InvalidIndexError(schema);
  }
  return version;
}

export interface MigrationLedgerState {
  readonly isOwner: boolean;
  readonly relkind: string | null;
  readonly validTable: boolean;
}

/**
 * Inspect schema ownership and migration-ledger relation state via system
 * catalogs only. Does not require SELECT privilege on `<schema>.migration`.
 */
export async function readMigrationLedgerState(
  sql: postgres.ISql,
  schema: string,
): Promise<MigrationLedgerState> {
  const [row] = await runSql(
    sql<
      {
        readonly is_owner: boolean;
        readonly migration_relkind: string | null;
        readonly valid_migration_table: boolean;
      }[]
    >`
      select
        n.nspowner = (select pg_catalog.to_regrole(current_user)::oid) as is_owner
      , c.relkind::text as migration_relkind
      , coalesce
        ( c.relkind = 'r'
          and exists
          (
            select 1
            from pg_catalog.pg_attribute a
            where a.attrelid = c.oid
            and a.attname = 'name'
            and a.attnum > 0
            and not a.attisdropped
            and a.atttypid = 'pg_catalog.text'::pg_catalog.regtype
          )
          and exists
          (
            select 1
            from pg_catalog.pg_attribute a
            inner join pg_catalog.pg_class vc on (vc.oid = a.attrelid)
            where vc.relnamespace = n.oid
            and vc.relname = 'version'
            and vc.relkind = 'r'
            and a.attname = 'version'
            and a.attnum > 0
            and not a.attisdropped
            and a.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
          )
          and exists
          (
            select 1
            from pg_catalog.pg_attribute a
            where a.attrelid = c.oid
            and a.attname = 'applied_at_version'
            and a.attnum > 0
            and not a.attisdropped
            and a.atttypid = 'pg_catalog.int8'::pg_catalog.regtype
          )
          and exists
          (
            select 1
            from pg_catalog.pg_attribute a
            where a.attrelid = c.oid
            and a.attname = 'applied_at'
            and a.attnum > 0
            and not a.attisdropped
            and a.atttypid = 'pg_catalog.timestamptz'::pg_catalog.regtype
          )
        , false
        ) as valid_migration_table
      from pg_catalog.pg_namespace n
      left join pg_catalog.pg_class c
        on c.relnamespace = n.oid
        and c.relname = 'migration'
      where n.nspname = ${schema}
    `,
    {
      spanName: "readMigrationLedgerState",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (!row) {
    throw new InvalidIndexError(schema);
  }
  return {
    isOwner: row.is_owner,
    relkind: row.migration_relkind,
    validTable: row.valid_migration_table,
  };
}

interface EmbeddingColumnRow {
  readonly type_name: string;
  readonly type_schema: string;
  readonly display_type: string;
}

interface VectorIndexOpclassRow {
  readonly relname: string;
  readonly opcname: string;
  readonly opclass_schema: string;
  readonly amname: string;
  readonly has_cosine_amop: boolean;
}

export interface ValidatedIndexShape extends StoredIndexShape {
  readonly vectorIndex: VectorIndexMethod;
}

/**
 * Inspect the index's stored embedding column and cosine ANN index (`hnsw` or
 * `prism`) in the catalog and return its validated vector type, dimensions, and
 * vector index access method.
 */
export async function readIndexShape(
  sql: postgres.ISql,
  schema: string,
): Promise<ValidatedIndexShape> {
  const embedding = await readEmbeddingColumn(sql, schema);
  if (embedding.type_schema !== "public") {
    throw new InvalidIndexError(schema);
  }
  const vectorShape = parseVectorShape(embedding, schema);
  const vectorIndex = await readVectorIndexOpclass(
    sql,
    schema,
    vectorShape.vectorType,
  );
  const method: VectorIndexMethod =
    vectorIndex.relname === "record_embedding_prism_idx" ? "prism" : "hnsw";
  const maxDimensions =
    method === "prism"
      ? MAX_PRISM_DIMENSIONS
      : MAX_VECTOR_DIMENSIONS[vectorShape.vectorType];
  if (
    vectorShape.dimensions < 1 ||
    vectorShape.dimensions > maxDimensions ||
    vectorIndex.amname !== method ||
    vectorIndex.opclass_schema !== "public" ||
    vectorIndex.opcname !==
      cosineOpclassForShape(vectorShape.vectorType, method) ||
    !vectorIndex.has_cosine_amop
  ) {
    throw new InvalidIndexError(schema);
  }
  return {
    vectorType: vectorShape.vectorType,
    dimensions: vectorShape.dimensions,
    vectorIndex: method,
  };
}

async function readEmbeddingColumn(
  sql: postgres.ISql,
  schema: string,
): Promise<EmbeddingColumnRow> {
  const [row] = await runSql(
    sql<EmbeddingColumnRow[]>`
      select
        t.typname as type_name
      , tn.nspname as type_schema
      , pg_catalog.format_type(a.atttypid, a.atttypmod) as display_type
      from pg_catalog.pg_attribute a
      inner join pg_catalog.pg_class c on (c.oid = a.attrelid)
      inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
      inner join pg_catalog.pg_type t on (t.oid = a.atttypid)
      inner join pg_catalog.pg_namespace tn on (tn.oid = t.typnamespace)
      where n.nspname = ${schema}
      and c.relname = 'record'
      and a.attname = 'embedding'
      and not a.attisdropped
    `,
    {
      spanName: "readEmbeddingColumn",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (!row) {
    throw new InvalidIndexError(schema);
  }
  return row;
}

function parseVectorShape(
  column: EmbeddingColumnRow,
  schema: string,
): { readonly vectorType: "vector" | "halfvec"; readonly dimensions: number } {
  if (column.type_name !== "vector" && column.type_name !== "halfvec") {
    throw new InvalidIndexError(schema);
  }
  const dimensions = /\((\d+)\)$/.exec(column.display_type)?.[1];
  if (!dimensions) {
    throw new InvalidIndexError(schema);
  }
  return {
    vectorType: column.type_name,
    dimensions: Number(dimensions),
  };
}

async function readVectorIndexOpclass(
  sql: postgres.ISql,
  schema: string,
  vectorType: "vector" | "halfvec",
): Promise<VectorIndexOpclassRow> {
  const rows = await runSql(
    sql<VectorIndexOpclassRow[]>`
      select
        c.relname
      , opc.opcname
      , opn.nspname as opclass_schema
      , am.amname
      , exists
        (
          select 1
          from pg_catalog.pg_amop amop
          inner join pg_catalog.pg_operator opr on (opr.oid = amop.amopopr)
          inner join pg_catalog.pg_namespace oprn on (oprn.oid = opr.oprnamespace)
          inner join pg_catalog.pg_type lt on (lt.oid = amop.amoplefttype)
          inner join pg_catalog.pg_namespace ltn on (ltn.oid = lt.typnamespace)
          where amop.amopfamily = opc.opcfamily
          and amop.amopmethod = am.oid
          and amop.amoppurpose = 'o'
          and amop.amopstrategy = 1
          and oprn.nspname = 'public'
          and opr.oprname = '<=>'
          and ltn.nspname = 'public'
          and lt.typname = ${vectorType}
          and amop.amoprighttype = amop.amoplefttype
        ) as has_cosine_amop
      from pg_catalog.pg_index i
      inner join pg_catalog.pg_class c on (c.oid = i.indexrelid)
      inner join pg_catalog.pg_namespace n on (n.oid = c.relnamespace)
      inner join pg_catalog.pg_opclass opc on (opc.oid = i.indclass[0])
      inner join pg_catalog.pg_namespace opn on (opn.oid = opc.opcnamespace)
      inner join pg_catalog.pg_am am on (am.oid = opc.opcmethod)
      where n.nspname = ${schema}
      and c.relname in ('record_embedding_hnsw_idx', 'record_embedding_prism_idx')
    `,
    {
      spanName: "readHnswOpclass",
      dbOperationName: "SELECT",
      namespace: schema,
    },
  );
  if (rows.length !== 1 || !rows[0]) {
    throw new InvalidIndexError(schema);
  }
  return rows[0];
}
