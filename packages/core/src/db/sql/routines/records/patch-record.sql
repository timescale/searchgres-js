-- ------------------------------------------------------------------------
-- patch_record
-- ------------------------------------------------------------------------
-- Optimistic-concurrency patch in one round trip. The `cur`/`upd` CTEs let the
-- caller distinguish the two failure modes without a second query: a zero-row
-- `UPDATE ... RETURNING` emits nothing, so `found` (does the id exist at all?)
-- and `updated` (did the version_hash still match?) separate NotFound from
-- Stale. Soundness under READ COMMITTED: if a concurrent tx commits a change
-- between the caller's read and this update, PostgreSQL re-evaluates the
-- UPDATE's WHERE against the new row (EvalPlanQual); version_hash no longer
-- matches, so `updated` is false and the caller correctly sees Stale rather
-- than silently clobbering the newer row.
create function {{schema_ident}}.patch_record
( _id uuid
, _prior_version_hash text
, _patch jsonb
, _embedding public.{{vector_type_ident}}({{dimensions_int}}) default null
)
returns table
( found boolean
, updated boolean
, id uuid
, content text
, meta jsonb
, tree public.ltree
, temporal tstzrange
, name text
, has_embedding boolean
, version bigint
, version_hash text
, created_at timestamptz
, updated_at timestamptz
)
language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
as $function$
      -- out columns (id, ...) shadow record columns; resolve to columns.
      #variable_conflict use_column
      begin
        -- A patch must change something. An embedding-only patch is valid.
        if _embedding is null
           and not exists
           (
             select 1 from jsonb_object_keys(coalesce(_patch, '{}'::jsonb)) k
             where k in ('content', 'meta', 'tree', 'name', 'temporal')
           )
        then
          raise exception 'patch has no updatable fields'
            using errcode = 'invalid_parameter_value';
        end if;

        -- tree is not-null in the table; a JSON null would violate it with a
        -- confusing error, so reject it here with a clear message.
        if _patch ? 'tree' and _patch->>'tree' is null then
          raise exception 'tree cannot be set to null'
            using errcode = 'invalid_parameter_value';
        end if;

        return query
        with cur as
        (
          select 1 from {{schema_ident}}.record m where m.id = _id
        ),
        upd as
        (
          update {{schema_ident}}.record m set
            content  = case when _patch ? 'content'  then _patch->>'content'            else m.content end
          , meta     = case when _patch ? 'meta'     then _patch->'meta'                 else m.meta end
          , tree     = case when _patch ? 'tree'     then (_patch->>'tree')::public.ltree else m.tree end
          , name     = case when _patch ? 'name'     then _patch->>'name'                else m.name end
          , temporal = case when _patch ? 'temporal' then (_patch->>'temporal')::tstzrange else m.temporal end
          , embedding = case when _embedding is not null then _embedding                 else m.embedding end
          where m.id = _id and m.version_hash = _prior_version_hash
          returning
            m.id, m.content, m.meta, m.tree, m.temporal, m.name
          , (m.embedding is not null) as has_embedding
          , m.version, m.version_hash, m.created_at, m.updated_at
        )
        select
          exists (select 1 from cur) as found
        , (u.id is not null) as updated
        , u.id, u.content, u.meta, u.tree, u.temporal, u.name, u.has_embedding
        , u.version, u.version_hash, u.created_at, u.updated_at
        from (select 1) _one
        left join upd u on true;
      end
      $function$;
