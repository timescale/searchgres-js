--------------------------------------------------------------------------------
-- batch_upsert
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.batch_upsert
( _ids uuid[]
, _contents text[]
, _metas jsonb
, _trees public.ltree[]
, _temporals tstzrange[]
, _names text[]
, _embeddings public.{{vector_type_ident}}[]
, _on_conflict text default 'replace'
)
returns table
( ord bigint
, id uuid
, status text
)
as $func$
-- The out columns (id, ...) shadow table columns inside the body; the
-- body never reads them as variables, so resolve ambiguity to columns.
#variable_conflict use_column
declare
  _rows jsonb;
begin
  -- Parallel arrays plus one JSON array of meta objects, aligned by
  -- position. _metas is a jsonb array (not jsonb[]) so drivers pass json
  -- values without double-encoding scalar strings.
  if cardinality(_ids) is distinct from cardinality(_contents)
    or cardinality(_ids) is distinct from cardinality(_trees)
    or jsonb_typeof(_metas) is distinct from 'array'
    or cardinality(_ids) is distinct from jsonb_array_length(_metas)
    or cardinality(_ids) is distinct from cardinality(_temporals)
    or cardinality(_ids) is distinct from cardinality(_names)
    or cardinality(_ids) is distinct from cardinality(_embeddings)
  then
    raise exception 'batch arrays must have equal lengths'
      using errcode = 'invalid_parameter_value';
  end if;

  if _on_conflict is null or _on_conflict not in ('error', 'replace', 'ignore') then
    raise exception 'invalid _on_conflict: %', _on_conflict
      using errcode = 'invalid_parameter_value';
  end if;

  -- A duplicate idempotency key within the batch is ambiguous (two
  -- outcomes for one key) and would slip past the per-key partitions.
  if exists
  (
    select 1
    from unnest(_ids) u(id)
    where u.id is not null
    group by u.id
    having count(*) > 1
  ) then
    raise exception 'duplicate explicit id within batch'
      using errcode = 'invalid_parameter_value';
  end if;

  if exists
  (
    select 1
    from unnest(_trees, _names) u(tree, name)
    where u.name is not null
    group by u.tree, u.name
    having count(*) > 1
  ) then
    raise exception 'duplicate (tree, name) within batch'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Two inputs with DIFFERENT keys can still resolve to the same
  -- existing row: an unnamed {id: X} and a {tree, name} slot already
  -- holding id X. Status is attributed by stored id, so that would mark
  -- both inputs from one write. Reject it. Skip the probe when either an
  -- explicit-id input or a named input is absent.
  if cardinality(array_remove(_ids, null)) > 0
    and exists (select 1 from unnest(_names) n(name) where n.name is not null)
    and exists
    (
      select 1
      from
      (
        select m.id
        from unnest(_ids, _names) u(id, name)
        join {{schema_ident}}.record m on m.id = u.id
        where u.id is not null
        and u.name is null
        union all
        select m.id
        from unnest(_trees, _names) u(tree, name)
        join {{schema_ident}}.record m
          on m.tree = u.tree
          and m.name = u.name
        where u.name is not null
      ) x
      group by x.id
      having count(*) > 1
    )
  then
    raise exception 'batch inputs target the same existing record through id and (tree, name)'
      using errcode = 'invalid_parameter_value';
  end if;

  -- One mutation statement (one snapshot). Its per-input outcomes are
  -- captured so a second statement can resolve skipped named rows.
  with source as
  (
    select
      u.ord::bigint as position
    , u.id as explicit_id
    , coalesce(u.id, uuidv7()) as id
    , u.content
    , coalesce(nullif(e.meta, 'null'::jsonb), '{}'::jsonb) as meta
    , u.tree
    , u.temporal
    , u.name
    , u.embedding
    from unnest(_ids, _contents, _trees, _temporals, _names, _embeddings)
      with ordinality u(id, content, tree, temporal, name, embedding, ord)
    join jsonb_array_elements(_metas) with ordinality e(meta, ord)
      on e.ord = u.ord
  )
  -- Named rows (with OR without an explicit id) dedup on (tree, name).
  , named_mutation as
  (
    insert into {{schema_ident}}.record as record
    ( id
    , content
    , meta
    , tree
    , temporal
    , name
    , embedding
    )
    select id, content, meta, tree, temporal, name, embedding
    from source
    where name is not null
    on conflict (tree, name) where name is not null do update set
      content = excluded.content
    , meta = excluded.meta
    , temporal = excluded.temporal
    , embedding = case
        when excluded.embedding is null
          and record.content is not distinct from excluded.content
        then record.embedding
        else excluded.embedding
      end
    where _on_conflict = 'replace'
    and
    (
      record.content is distinct from excluded.content
      or record.meta is distinct from excluded.meta
      or record.temporal is distinct from excluded.temporal
      or
      (
        excluded.embedding is not null
        and record.embedding::text is distinct from excluded.embedding::text
      )
    )
    returning
      record.id
    , record.tree::text as tree
    , record.name
    , (xmax = 0) as inserted
  )
  -- Unnamed rows with an explicit id dedup on the id (import identity);
  -- an id-keyed replace can also move or rename the row.
  , id_mutation as
  (
    insert into {{schema_ident}}.record as record
    ( id
    , content
    , meta
    , tree
    , temporal
    , name
    , embedding
    )
    select id, content, meta, tree, temporal, name, embedding
    from source
    where name is null
    and explicit_id is not null
    on conflict (id) do update set
      tree = excluded.tree
    , name = excluded.name
    , content = excluded.content
    , meta = excluded.meta
    , temporal = excluded.temporal
    , embedding = case
        when excluded.embedding is null
          and record.content is not distinct from excluded.content
        then record.embedding
        else excluded.embedding
      end
    where _on_conflict = 'replace'
    and
    (
      record.tree is distinct from excluded.tree
      or record.name is distinct from excluded.name
      or record.content is distinct from excluded.content
      or record.meta is distinct from excluded.meta
      or record.temporal is distinct from excluded.temporal
      or
      (
        excluded.embedding is not null
        and record.embedding::text is distinct from excluded.embedding::text
      )
    )
    returning
      record.id
    , record.tree::text as tree
    , record.name
    , (xmax = 0) as inserted
  )
  -- Anonymous rows always insert (their generated id is unique).
  , anonymous_mutation as
  (
    insert into {{schema_ident}}.record as record
    ( id
    , content
    , meta
    , tree
    , temporal
    , name
    , embedding
    )
    select id, content, meta, tree, temporal, name, embedding
    from source
    where name is null
    and explicit_id is null
    returning
      record.id
    , record.tree::text as tree
    , record.name
    , true as inserted
  )
  , mutation as
  (
    select id, tree, name, inserted from named_mutation
    union all
    select id, tree, name, inserted from id_mutation
    union all
    select id, tree, name, inserted from anonymous_mutation
  )
  select jsonb_agg
  (
    jsonb_build_object
    ( 'position', source.position
    , 'mutation_id', mutation.id
    , 'source_id', source.id
    , 'tree', source.tree::text
    , 'name', source.name
    , 'status', case
        when mutation.id is null then 'skipped'
        when mutation.inserted then 'inserted'
        else 'updated'
      end
    )
    order by source.position
  )
  into _rows
  from source
  left outer join mutation
    on
    (
      source.name is not null
      and mutation.tree = source.tree::text
      and mutation.name = source.name
    )
    or
    (
      source.name is null
      and mutation.id = source.id
    );

  -- 'error' does nothing on conflict above (like 'ignore'), then fails
  -- the whole statement here so partial inserts roll back.
  if _on_conflict = 'error'
    and _rows is not null
    and exists
    (
      select 1
      from jsonb_array_elements(_rows) e
      where e->>'status' = 'skipped'
    )
  then
    raise exception 'record already exists (id or tree/name conflict)'
      using errcode = 'unique_violation';
  end if;

  -- A skipped named row's stored id is resolved against a FRESH snapshot
  -- (a new statement), so a concurrently committed conflicting row yields
  -- its kept id rather than this batch's minted id.
  return query
  select
    (e->>'position')::bigint as ord
  , coalesce
    ( (e->>'mutation_id')::uuid
    , case
        when e->>'name' is null then (e->>'source_id')::uuid
        else
        (
          select r.id
          from {{schema_ident}}.record r
          where r.tree::text = e->>'tree'
          and r.name = e->>'name'
        )
      end
    ) as id
  , e->>'status' as status
  from jsonb_array_elements(coalesce(_rows, '[]'::jsonb)) e
  order by (e->>'position')::bigint;
end;
$func$ language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- get_record / get_record_by_name
--------------------------------------------------------------------------------
-- Deliberately no SET clause: these stable SQL reads must remain inlineable.
-- Qualified tables/operators keep them safe under an arbitrary caller path.
create or replace function {{schema_ident}}.get_record(_id uuid)
returns table
( id uuid
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
as $func$
  select
    m.id
  , m.content
  , m.meta
  , m.tree
  , m.temporal
  , m.name
  , (m.embedding is not null)
  , m.version
  , m.version_hash
  , m.created_at
  , m.updated_at
  from {{schema_ident}}.record m
  where m.id operator(pg_catalog.=) _id
$func$ language sql stable security invoker
;

-- Deliberately no SET clause: these stable SQL reads must remain inlineable.
-- Qualified tables/operators keep them safe under an arbitrary caller path.
create or replace function {{schema_ident}}.get_record_by_name
( _tree public.ltree
, _name text
)
returns table
( id uuid
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
as $func$
  select
    m.id
  , m.content
  , m.meta
  , m.tree
  , m.temporal
  , m.name
  , (m.embedding is not null)
  , m.version
  , m.version_hash
  , m.created_at
  , m.updated_at
  from {{schema_ident}}.record m
  where m.tree operator(public.=) _tree
  and m.name operator(pg_catalog.=) _name
$func$ language sql stable security invoker
;

--------------------------------------------------------------------------------
-- patch_record
--------------------------------------------------------------------------------
-- Optimistic-concurrency patch in one round trip. The `cur`/`upd` CTEs let the
-- caller distinguish the two failure modes without a second query: a zero-row
-- `UPDATE ... RETURNING` emits nothing, so `found` (does the id exist at all?)
-- and `updated` (did the version_hash still match?) separate NotFound from
-- Stale. Soundness under READ COMMITTED: if a concurrent tx commits a change
-- between the caller's read and this update, PostgreSQL re-evaluates the
-- UPDATE's WHERE against the new row (EvalPlanQual); version_hash no longer
-- matches, so `updated` is false and the caller correctly sees Stale rather
-- than silently clobbering the newer row.
create or replace function {{schema_ident}}.patch_record
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
as $func$
-- out columns (id, ...) shadow record columns; resolve to columns.
#variable_conflict use_column
begin
  -- A patch must change something. An embedding-only patch is valid.
  if _embedding is null
    and not exists
    (
      select 1
      from jsonb_object_keys(coalesce(_patch, '{}'::jsonb)) k
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
    select 1
    from {{schema_ident}}.record m
    where m.id = _id
  )
  , upd as
  (
    update {{schema_ident}}.record m set
      content   = case when _patch ? 'content'  then _patch->>'content'            else m.content end
    , meta      = case when _patch ? 'meta'     then _patch->'meta'                 else m.meta end
    , tree      = case when _patch ? 'tree'     then (_patch->>'tree')::public.ltree else m.tree end
    , name      = case when _patch ? 'name'     then _patch->>'name'                else m.name end
    , temporal  = case when _patch ? 'temporal' then (_patch->>'temporal')::tstzrange else m.temporal end
    , embedding = case when _embedding is not null then _embedding                 else m.embedding end
    where m.id = _id
    and m.version_hash = _prior_version_hash
    returning
      m.id
    , m.content
    , m.meta
    , m.tree
    , m.temporal
    , m.name
    , (m.embedding is not null) as has_embedding
    , m.version
    , m.version_hash
    , m.created_at
    , m.updated_at
  )
  select
    exists (select 1 from cur) as found
  , (u.id is not null) as updated
  , u.id
  , u.content
  , u.meta
  , u.tree
  , u.temporal
  , u.name
  , u.has_embedding
  , u.version
  , u.version_hash
  , u.created_at
  , u.updated_at
  from (select 1) _one
  left join upd u on true;
end;
$func$ language plpgsql volatile security invoker
set timezone to 'UTC'
set datestyle to 'ISO, YMD'
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- delete_record / delete_record_by_name
--------------------------------------------------------------------------------
-- Return whether an exact row was removed (queue rows cascade via the FK). The
-- TS layer maps false to NotFoundError.
create or replace function {{schema_ident}}.delete_record(_id uuid)
returns boolean
as $func$
  with deleted as
  (
    delete from {{schema_ident}}.record
    where id = _id
    returning 1
  )
  select exists (select 1 from deleted)
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

create or replace function {{schema_ident}}.delete_record_by_name
( _tree public.ltree
, _name text
)
returns boolean
as $func$
  with deleted as
  (
    delete from {{schema_ident}}.record
    where tree operator(public.=) _tree
    and name = _name
    returning 1
  )
  select exists (select 1 from deleted)
$func$ language sql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- vector_index_stats
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.vector_index_stats()
returns table
( method text
, index_name text
, index_size_bytes bigint
, embedded_records bigint
, prism_nlist integer
, prism_pinned_nlist integer
, prism_ideal_nlist integer
, prism_target_pages integer
, prism_target_entries integer
, prism_nlevels integer
, prism_posting_pages bigint
, prism_needs_reindex boolean
, prism_reindex_reason text
)
as $func$
#variable_conflict use_column
declare
  _index_oid oid;
  _index_name text;
  _method text;
  _size_bytes bigint;
  _embedded bigint;
  _nlist integer;
  _pinned_nlist integer;
  _target_pages integer;
  _target_entries integer;
  _nlevels integer;
  _posting_pages bigint;
  _count float8;
  _linear integer;
  _min_lists integer;
  _ideal_nlist integer;
  _effective_target_nlist integer;
  _needs_reindex boolean;
  _reason text;
begin
  select
    c.oid
  , c.relname::text
  , am.amname::text
  , pg_catalog.pg_relation_size(c.oid)
  , (
      select substring(opt from '^nlist=([0-9]+)$')::integer
      from pg_catalog.unnest(c.reloptions) opt
      where opt like 'nlist=%'
      limit 1
    )
  into
    _index_oid
  , _index_name
  , _method
  , _size_bytes
  , _pinned_nlist
  from pg_catalog.pg_class c
  inner join pg_catalog.pg_am am
    on am.oid = c.relam
  where c.oid = {{vector_index_literal}}::pg_catalog.regclass;

  select count(*) filter (where r.embedding is not null)::bigint
  into _embedded
  from {{schema_ident}}.record r;

  if _method = 'prism' then
    select
      max(s.setting::integer) filter (where s.name = 'nlist')
    , max(s.setting::integer) filter (where s.name = 'target_pages')
    , max(s.setting::integer) filter (where s.name = 'target_entries')
    , max(s.setting::integer) filter (where s.name = 'nlevels')
    , max(s.setting::bigint) filter (where s.name = 'posting_pages')
    into
      _nlist
    , _target_pages
    , _target_entries
    , _nlevels
    , _posting_pages
    from public.prism_index_settings(_index_oid) s;

    _count := greatest(_embedded::float8, 1.0);
    _linear := trunc(_count / _target_entries::float8 + 0.5)::integer;
    _min_lists := trunc(sqrt(_count))::integer;
    _ideal_nlist := greatest(_linear, _min_lists, 1);

    if _pinned_nlist is not null and _pinned_nlist > 0 then
      _effective_target_nlist := least(
        _pinned_nlist,
        greatest(least(_embedded, 2000000)::integer, 1)
      );
    else
      _effective_target_nlist := _ideal_nlist;
    end if;

    if _nlist = 1 and _effective_target_nlist >= 2 then
      _needs_reindex := true;
      _reason := 'bootstrap_single_cluster';
    elsif _embedded > (_nlist::bigint * _target_entries::bigint * 2)
      and _effective_target_nlist > _nlist
    then
      _needs_reindex := true;
      _reason := 'cluster_drift';
    else
      _needs_reindex := false;
      _reason := null;
    end if;
  end if;

  return query
  select
    _method
  , _index_name
  , _size_bytes
  , _embedded
  , _nlist
  , _pinned_nlist
  , _ideal_nlist
  , _target_pages
  , _target_entries
  , _nlevels
  , _posting_pages
  , _needs_reindex
  , _reason;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;
