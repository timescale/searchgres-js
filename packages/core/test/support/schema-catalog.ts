import assert from "node:assert/strict";
import type { Sql } from "postgres";
import type { IndexConfig } from "../../src/config.ts";

/** These are input configs, not normalized copies of the implementation defaults. */
export const SCHEMA_FORMAT_CASES = [
  { name: "halfvec-default-4", config: { dimensions: 4 } },
  { name: "vector-default-4", config: { dimensions: 4, vectorType: "vector" } },
  {
    name: "vector-custom-8",
    config: {
      dimensions: 8,
      vectorType: "vector",
      bm25: { textConfig: "simple", k1: 1.7, b: 0.5 },
      hnsw: { m: 8, efConstruction: 40 },
    },
  },
  {
    name: "halfvec-custom-8",
    config: {
      dimensions: 8,
      vectorType: "halfvec",
      bm25: { textConfig: "simple", k1: 1.7, b: 0.5 },
      hnsw: { m: 8, efConstruction: 40 },
    },
  },
] as const satisfies readonly { name: string; config: IndexConfig }[];

export const CATALOG_SCHEMA_TOKEN = "__searchgres_schema__";

export interface CatalogFixture {
  readonly config: IndexConfig;
  readonly catalog: Record<string, unknown>;
}

/** Diagnostic/provenance only: patch versions are deliberately not snapshot assertions. */
export async function catalogEnvironment(sql: Sql): Promise<unknown> {
  const [server] = await sql`
    select pg_catalog.current_setting('server_version') as version,
           pg_catalog.current_setting('server_version_num') as version_num,
           pg_catalog.current_setting('server_encoding') as encoding
  `;
  const extensions = await sql`
    select e.extname as name, e.extversion as version, n.nspname as schema
    from pg_catalog.pg_extension e
    join pg_catalog.pg_namespace n on n.oid = e.extnamespace
    where e.extname in ('vector', 'pg_textsearch', 'ltree')
    order by e.extname collate "C"
  `;
  return { server, extensions: Array.from(extensions) };
}

/**
 * Read one newly created index, on one connection with explicit deparser GUCs.
 * No row data is read except the immutable version marker. In particular there
 * are no timestamps, sequence values, owner/ACL names, statistics or OIDs.
 *
 * Keep function definitions and source verbatim, including whitespace. The ONLY
 * replacement is this concrete, randomly generated test schema's spelling.
 * Internal FK trigger names contain OIDs; omit those names/definitions, but keep
 * their full stable event/function/constraint metadata and multiplicity.
 */
export async function schemaCatalog(
  sql: Sql,
  schema: string,
): Promise<Record<string, unknown>> {
  assert.match(schema, /^sgtest_[a-z0-9]+$/);
  const catalog = await sql.begin(async (tx) => {
    await tx`set transaction isolation level repeatable read, read only`;
    await tx`set local search_path to pg_catalog`;
    await tx`set local timezone to 'UTC'`;
    await tx`set local datestyle to 'ISO, YMD'`;
    await tx`set local intervalstyle to 'postgres'`;
    await tx`set local extra_float_digits to 3`;
    await tx`set local standard_conforming_strings to on`;
    await tx`set local quote_all_identifiers to off`;
    await tx`set local bytea_output to 'hex'`;
    const [server] = await tx`
      select pg_catalog.current_setting('server_version_num')::integer / 10000 as major
    `;
    assert.equal(
      server?.major,
      18,
      "format-2 catalog fixtures require PostgreSQL 18",
    );

    const namespace = await tx`
      select n.nspname as name,
             pg_catalog.obj_description(n.oid, 'pg_namespace') as comment
      from pg_catalog.pg_namespace n
      where n.nspname = ${schema}
    `;
    assert.equal(namespace.length, 1);
    const versions = await tx`
      select version from ${tx(schema)}.version order by version
    `;
    const relations = await tx`
      select c.relname as name, c.relkind as kind, c.relpersistence as persistence,
             am.amname as access_method, ts.spcname as tablespace,
             c.reloptions as options, c.relreplident as replica_identity,
             c.relrowsecurity as row_security, c.relforcerowsecurity as force_row_security,
             c.relispopulated as populated, c.relispartition as is_partition,
             c.relhasrules as has_rules, c.relhastriggers as has_triggers,
             c.relchecks as check_count,
             case when c.relkind in ('v', 'm') then pg_catalog.pg_get_viewdef(c.oid, false) end as view_definition,
             case when c.relkind = 'p' then pg_catalog.pg_get_partkeydef(c.oid) end as partition_key,
             pg_catalog.pg_get_expr(c.relpartbound, c.oid, false) as partition_bound,
             pg_catalog.obj_description(c.oid, 'pg_class') as comment
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_am am on am.oid = c.relam
      left join pg_catalog.pg_tablespace ts on ts.oid = c.reltablespace
      where n.nspname = ${schema}
      order by c.relname collate "C"
    `;
    const columns = await tx`
      select c.relname as relation, a.attnum as position, a.attname as name,
             pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
             a.attndims as dimensions, a.attnotnull as not_null,
             a.attidentity as identity, a.attgenerated as generated,
             a.attisdropped as dropped, a.attislocal as is_local,
             a.attinhcount as inheritance_count,
             a.attstorage as storage, a.attcompression as compression,
             a.attoptions as options, a.attfdwoptions as fdw_options,
             case when co.oid is not null then pg_catalog.format('%I.%I', cn.nspname, co.collname) end as collation,
             pg_catalog.pg_get_expr(d.adbin, d.adrelid, false) as default_expression,
             pg_catalog.col_description(c.oid, a.attnum) as comment
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      left join pg_catalog.pg_collation co on co.oid = a.attcollation
      left join pg_catalog.pg_namespace cn on cn.oid = co.collnamespace
      where n.nspname = ${schema} and a.attnum > 0
      order by c.relname collate "C", a.attnum
    `;
    const constraints = await tx`
      select co.conname as name, c.relname as relation, ty.typname as domain,
             co.contype as type, co.condeferrable as deferrable,
             co.condeferred as initially_deferred, co.convalidated as validated,
             co.conenforced as enforced, co.conislocal as is_local,
             co.coninhcount as inheritance_count, co.connoinherit as no_inherit,
             co.conkey as columns, co.confkey as referenced_columns,
             case when rc.oid is not null then pg_catalog.format('%I.%I', rn.nspname, rc.relname) end as referenced_relation,
             ic.relname as supporting_index,
             pg_catalog.pg_get_constraintdef(co.oid, false) as definition,
             pg_catalog.obj_description(co.oid, 'pg_constraint') as comment
      from pg_catalog.pg_constraint co
      join pg_catalog.pg_namespace n on n.oid = co.connamespace
      left join pg_catalog.pg_class c on c.oid = co.conrelid
      left join pg_catalog.pg_type ty on ty.oid = co.contypid
      left join pg_catalog.pg_class rc on rc.oid = co.confrelid
      left join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
      left join pg_catalog.pg_class ic on ic.oid = co.conindid
      where n.nspname = ${schema}
      order by c.relname collate "C", ty.typname collate "C", co.conname collate "C"
    `;
    const indexes = await tx`
      select ic.relname as name, c.relname as relation,
             pg_catalog.pg_get_indexdef(i.indexrelid, 0, false) as definition,
             i.indnatts as attribute_count, i.indnkeyatts as key_attribute_count,
             i.indisunique as is_unique, i.indnullsnotdistinct as nulls_not_distinct,
             i.indisprimary as is_primary, i.indisexclusion as is_exclusion,
             i.indimmediate as immediate, i.indisclustered as clustered,
             i.indisvalid as valid, i.indisready as ready, i.indislive as live,
             i.indisreplident as replica_identity,
             i.indkey::smallint[] as columns, i.indoption::smallint[] as column_options,
             pg_catalog.pg_get_expr(i.indexprs, i.indrelid, false) as expressions,
             pg_catalog.pg_get_expr(i.indpred, i.indrelid, false) as predicate,
             (select pg_catalog.jsonb_agg(pg_catalog.format('%I.%I', onsp.nspname, op.opcname) order by u.position)
              from pg_catalog.unnest(i.indclass) with ordinality u(opclass, position)
              join pg_catalog.pg_opclass op on op.oid = u.opclass
              join pg_catalog.pg_namespace onsp on onsp.oid = op.opcnamespace) as opclasses,
             (select pg_catalog.jsonb_agg(case when co.oid is not null then pg_catalog.format('%I.%I', cn.nspname, co.collname) end order by u.position)
              from pg_catalog.unnest(i.indcollation) with ordinality u(collation_oid, position)
              left join pg_catalog.pg_collation co on co.oid = u.collation_oid
              left join pg_catalog.pg_namespace cn on cn.oid = co.collnamespace) as collations
      from pg_catalog.pg_index i
      join pg_catalog.pg_class ic on ic.oid = i.indexrelid
      join pg_catalog.pg_class c on c.oid = i.indrelid
      join pg_catalog.pg_namespace n on n.oid = ic.relnamespace
      where n.nspname = ${schema}
      order by ic.relname collate "C"
    `;
    const functions = await tx`
      select p.proname as name, p.prokind as kind, l.lanname as language,
             pg_catalog.pg_get_function_identity_arguments(p.oid) as identity_arguments,
             pg_catalog.pg_get_function_arguments(p.oid) as arguments,
             pg_catalog.pg_get_function_result(p.oid) as result,
             case when p.prokind <> 'a' then pg_catalog.pg_get_functiondef(p.oid) end as definition,
             p.prosrc as source, p.probin as binary,
             p.proconfig as settings, p.prosecdef as security_definer,
             p.provolatile as volatility, p.proparallel as parallel,
             p.proisstrict as strict, p.proleakproof as leakproof,
             p.proretset as returns_set, p.procost as cost, p.prorows as rows,
             pg_catalog.obj_description(p.oid, 'pg_proc') as comment
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join pg_catalog.pg_language l on l.oid = p.prolang
      where n.nspname = ${schema}
      order by p.proname collate "C", pg_catalog.pg_get_function_identity_arguments(p.oid) collate "C"
    `;
    const triggers = await tx`
      select c.relname as relation, t.tgisinternal as internal,
             case when not t.tgisinternal then t.tgname end as name,
             case when not t.tgisinternal then pg_catalog.pg_get_triggerdef(t.oid, false) end as definition,
             t.tgtype as type, t.tgenabled as enabled,
             pg_catalog.format('%I.%I', pn.nspname, p.proname) as function,
             pg_catalog.pg_get_function_identity_arguments(p.oid) as function_arguments,
             t.tgdeferrable as deferrable, t.tginitdeferred as initially_deferred,
             co.conname as constraint_name, cc.relname as constraint_relation,
             t.tgattr::smallint[] as columns,
             pg_catalog.encode(t.tgargs, 'hex') as arguments,
             (t.tgqual is not null) as has_condition,
             t.tgoldtable as old_transition_table, t.tgnewtable as new_transition_table
      from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_proc p on p.oid = t.tgfoid
      join pg_catalog.pg_namespace pn on pn.oid = p.pronamespace
      left join pg_catalog.pg_constraint co on co.oid = t.tgconstraint
      left join pg_catalog.pg_class cc on cc.oid = t.tgconstrrelid
      where n.nspname = ${schema}
      order by c.relname collate "C", t.tgisinternal,
               (case when not t.tgisinternal then t.tgname end) collate "C",
               pn.nspname collate "C", p.proname collate "C", t.tgtype,
               co.conname collate "C"
    `;
    const sequences = await tx`
      select c.relname as name, pg_catalog.format_type(s.seqtypid, null) as type,
             s.seqstart::text as start, s.seqincrement::text as increment,
             s.seqmax::text as maximum, s.seqmin::text as minimum,
             s.seqcache::text as cache, s.seqcycle as cycle,
             d.deptype as dependency_type, oc.relname as owning_relation,
             a.attname as owning_column
      from pg_catalog.pg_sequence s
      join pg_catalog.pg_class c on c.oid = s.seqrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      left join pg_catalog.pg_depend d on d.classid = 'pg_class'::regclass
        and d.objid = c.oid and d.refclassid = 'pg_class'::regclass and d.deptype in ('a', 'i')
      left join pg_catalog.pg_class oc on oc.oid = d.refobjid
      left join pg_catalog.pg_attribute a on a.attrelid = oc.oid and a.attnum = d.refobjsubid
      where n.nspname = ${schema}
      order by c.relname collate "C"
    `;
    const types = await tx`
      select t.typname as name, t.typtype as kind, t.typcategory as category,
             t.typnotnull as not_null, t.typispreferred as preferred,
             t.typdelim as delimiter, t.typlen as length, t.typbyval as by_value,
             t.typalign as alignment, t.typstorage as storage,
             c.relname as relation,
             case when t.typelem <> 0 then pg_catalog.format_type(t.typelem, null) end as element_type,
             case when t.typbasetype <> 0 then pg_catalog.format_type(t.typbasetype, t.typtypmod) end as base_type,
             t.typdefault as default_expression,
             (select pg_catalog.jsonb_agg(e.enumlabel order by e.enumsortorder)
              from pg_catalog.pg_enum e where e.enumtypid = t.oid) as enum_labels
      from pg_catalog.pg_type t
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      left join pg_catalog.pg_class c on c.oid = t.typrelid
      where n.nspname = ${schema}
      order by t.typname collate "C"
    `;
    const inheritance = await tx`
      select c.relname as child, pg_catalog.format('%I.%I', pn.nspname, p.relname) as parent,
             i.inhseqno as position, i.inhdetachpending as detach_pending
      from pg_catalog.pg_inherits i
      join pg_catalog.pg_class c on c.oid = i.inhrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      join pg_catalog.pg_class p on p.oid = i.inhparent
      join pg_catalog.pg_namespace pn on pn.oid = p.relnamespace
      where n.nspname = ${schema}
      order by c.relname collate "C", i.inhseqno
    `;
    const rules = await tx`
      select c.relname as relation, r.rulename as name,
             r.ev_enabled as enabled, pg_catalog.pg_get_ruledef(r.oid, false) as definition
      from pg_catalog.pg_rewrite r
      join pg_catalog.pg_class c on c.oid = r.ev_class
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema}
      order by c.relname collate "C", r.rulename collate "C"
    `;
    const policies = await tx`
      select c.relname as relation, p.polname as name, p.polcmd as command,
             p.polpermissive as permissive,
             pg_catalog.pg_get_expr(p.polqual, p.polrelid, false) as using_expression,
             pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid, false) as check_expression
      from pg_catalog.pg_policy p
      join pg_catalog.pg_class c on c.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where n.nspname = ${schema}
      order by c.relname collate "C", p.polname collate "C"
    `;
    // Catch additional schema-local objects even outside the categories above,
    // e.g. an accidentally retained helper operator, aggregate, or collation.
    const inventory = await tx`
      select id.type, id.schema, id.name, id.identity, d.deptype as dependency_type
      from pg_catalog.pg_depend d
      join pg_catalog.pg_namespace n on d.refclassid = 'pg_namespace'::regclass and d.refobjid = n.oid
      cross join lateral pg_catalog.pg_identify_object(d.classid, d.objid, d.objsubid) id
      where n.nspname = ${schema}
      order by id.type collate "C", id.identity collate "C", d.deptype
    `;
    return {
      namespace: Array.from(namespace),
      versions: Array.from(versions),
      relations: Array.from(relations),
      columns: Array.from(columns),
      constraints: Array.from(constraints),
      indexes: Array.from(indexes),
      functions: Array.from(functions),
      triggers: Array.from(triggers),
      sequences: Array.from(sequences),
      types: Array.from(types),
      inheritance: Array.from(inheritance),
      rules: Array.from(rules),
      policies: Array.from(policies),
      inventory: Array.from(inventory),
    };
  });
  return JSON.parse(
    JSON.stringify(catalog).replaceAll(schema, CATALOG_SCHEMA_TOKEN),
  ) as Record<string, unknown>;
}
