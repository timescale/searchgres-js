--------------------------------------------------------------------------------
-- move_tree
--------------------------------------------------------------------------------
-- Rewrite the ltree prefix of every record at or under `_src` to `_dst`,
-- preserving id/name/content/meta/temporal/embedding. record_integrity fires
-- per row (tree changed → version/hash advance; content/embedding unchanged →
-- no re-embed). Unlike ME's snapshot-then-update, this is a SINGLE UPDATE
-- whose WHERE is re-checked by PostgreSQL against the live row (EvalPlanQual):
-- a row a concurrent writer moved out from under `_src` between planning and
-- execution is no longer matched and is not mis-rewritten, and the RETURNING
-- count reflects rows actually updated, not a stale snapshot. A destination
-- (tree, name) collision raises 23505 and rolls the whole statement back.
create or replace function {{schema_ident}}.move_tree
( _src public.ltree
, _dst public.ltree
, _dry_run boolean default false
)
returns bigint
as $func$
declare
  _n bigint;
begin
  if _dry_run then
    select count(*) into _n
    from {{schema_ident}}.record m
    where _src operator(public.@>) m.tree;
    return _n;
  end if;

  with moved as
  (
    update {{schema_ident}}.record m set
      tree = case
        when public.nlevel(m.tree) = public.nlevel(_src) then _dst
        else _dst operator(public.||) public.subpath
          ( m.tree
          , public.nlevel(_src)
          , public.nlevel(m.tree) - public.nlevel(_src)
          )
      end
    where _src operator(public.@>) m.tree
    returning m.id
  )
  select count(*) into _n
  from moved;
  return _n;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- copy_tree
--------------------------------------------------------------------------------
-- Insert a fresh record for each source-subtree row under `_dst`. New rows get
-- a generated UUIDv7 and content_version/version reset to 1 by the insert
-- trigger; a copied non-null embedding is preserved (no re-embed), a null one
-- enqueues normally. The source is untouched; a destination (tree, name)
-- collision raises 23505 and rolls back.
create or replace function {{schema_ident}}.copy_tree
( _src public.ltree
, _dst public.ltree
, _dry_run boolean default false
)
returns bigint
as $func$
declare
  _n bigint;
begin
  if _dry_run then
    select count(*) into _n
    from {{schema_ident}}.record m
    where _src operator(public.@>) m.tree;
    return _n;
  end if;

  with copied as
  (
    insert into {{schema_ident}}.record
    ( content
    , meta
    , tree
    , temporal
    , name
    , embedding
    )
    select
      m.content
    , m.meta
    , case
        when public.nlevel(m.tree) = public.nlevel(_src) then _dst
        else _dst operator(public.||) public.subpath
          ( m.tree
          , public.nlevel(_src)
          , public.nlevel(m.tree) - public.nlevel(_src)
          )
      end
    , m.temporal
    , m.name
    , m.embedding
    from {{schema_ident}}.record m
    where _src operator(public.@>) m.tree
    returning id
  )
  select count(*) into _n
  from copied;
  return _n;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- delete_tree
--------------------------------------------------------------------------------
-- Delete the inclusive subtree; queue rows cascade via the FK. Returns the
-- count (dry-run counts without deleting).
create or replace function {{schema_ident}}.delete_tree
( _tree public.ltree
, _dry_run boolean default false
)
returns bigint
as $func$
declare
  _n bigint;
begin
  if _dry_run then
    select count(*) into _n
    from {{schema_ident}}.record m
    where _tree operator(public.@>) m.tree;
    return _n;
  end if;

  with deleted as
  (
    delete from {{schema_ident}}.record m
    where _tree operator(public.@>) m.tree
    returning m.id
  )
  select count(*) into _n
  from deleted;
  return _n;
end;
$func$ language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- count_tree (three explicit filter kinds)
--------------------------------------------------------------------------------
-- `_max_count` bounds the scan; the TS layer passes max+1 so it can tell an
-- exact count from a capped one. `limit null` means no cap. These SQL `stable`
-- routines omit `set search_path` (a SET clause records proconfig, which
-- — though these are not inlineable, having a relation scan/subquery/aggregate
-- — needlessly costs a per-call GUC save/restore); every reference is fully
-- qualified so they are correct under any caller path.
create or replace function {{schema_ident}}.count_tree
( _tree public.ltree
, _max_count bigint default null
)
returns bigint
as $func$
  select pg_catalog.count(*)
  from
  (
    select 1
    from {{schema_ident}}.record m
    where _tree operator(public.@>) m.tree
    limit _max_count
  ) t
$func$ language sql stable security invoker
;

create or replace function {{schema_ident}}.count_tree
( _query public.lquery
, _max_count bigint default null
)
returns bigint
as $func$
  select pg_catalog.count(*)
  from
  (
    select 1
    from {{schema_ident}}.record m
    where m.tree operator(public.~) _query
    limit _max_count
  ) t
$func$ language sql stable security invoker
;

create or replace function {{schema_ident}}.count_tree
( _query public.ltxtquery
, _max_count bigint default null
)
returns bigint
as $func$
  select pg_catalog.count(*)
  from
  (
    select 1
    from {{schema_ident}}.record m
    where m.tree operator(public.@) _query
    limit _max_count
  ) t
$func$ language sql stable security invoker
;

--------------------------------------------------------------------------------
-- tree_view
--------------------------------------------------------------------------------
-- Inclusive display tree rooted at `_base`. Unlike list_tree, this includes
-- the requested base itself (the empty ltree becomes the CLI's synthetic
-- `.` root) and bounds prefix expansion at `_levels` relative depth.
create or replace function {{schema_ident}}.tree_view
( _base public.ltree
, _levels integer default null
)
returns table
( tree public.ltree
, count bigint
)
as $func$
  with matched as materialized
  (
    select m.id, m.tree
    from {{schema_ident}}.record m
    where _base operator(public.@>) m.tree
  )
  select
    public.subltree(matched.tree, 0, i) as tree
  , pg_catalog.count(matched.id) as count
  from matched
  cross join lateral pg_catalog.generate_series
  ( public.nlevel(_base)
  , case
      when _levels is null then public.nlevel(matched.tree)
      else least(public.nlevel(matched.tree), public.nlevel(_base) + _levels)
    end
  ) i
  group by 1
  order by 1
$func$ language sql stable security invoker
;

--------------------------------------------------------------------------------
-- list_tree
--------------------------------------------------------------------------------
-- For every record matching `_query`, emit each of its non-root ancestor
-- prefixes and count how many records fall under each. A matching record thus
-- contributes to every ancestor node, so counts are descendant totals, not
-- immediate-child counts. Ordered by tree for a stable listing.
--
-- SQL `stable`, single-`SELECT`, `security invoker`, and — like the record
-- reads — it omits `set search_path` so PostgreSQL can inline it. Everything
-- is fully qualified (table by schema, ltree ops/functions by `public`,
-- aggregate and set function by `pg_catalog`) to stay correct under any path.
create or replace function {{schema_ident}}.list_tree(_query public.lquery)
returns table
( tree public.ltree
, count bigint
)
as $func$
  with matched as
  (
    select distinct m.id, m.tree
    from {{schema_ident}}.record m
    where m.tree operator(public.~) _query
  )
  select
    public.subltree(matched.tree, 0, i) as tree
  , pg_catalog.count(matched.id) as count
  from matched
  cross join lateral pg_catalog.generate_series(1, public.nlevel(matched.tree)) i
  group by 1
  order by 1
$func$ language sql stable security invoker
;
