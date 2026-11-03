-- ------------------------------------------------------------------------
-- move_tree
-- ------------------------------------------------------------------------
-- Rewrite the ltree prefix of every record at or under `_src` to `_dst`,
-- preserving id/name/content/meta/temporal/embedding. record_integrity fires
-- per row (tree changed → version/hash advance; content/embedding unchanged →
-- no re-embed). Unlike ME's snapshot-then-update, this is a SINGLE UPDATE
-- whose WHERE is re-checked by PostgreSQL against the live row (EvalPlanQual):
-- a row a concurrent writer moved out from under `_src` between planning and
-- execution is no longer matched and is not mis-rewritten, and the RETURNING
-- count reflects rows actually updated, not a stale snapshot. A destination
-- (tree, name) collision raises 23505 and rolls the whole statement back.
create function {{schema_ident}}.move_tree
( _src public.ltree
, _dst public.ltree
, _dry_run boolean default false
)
returns bigint
language plpgsql volatile security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
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
          update {{schema_ident}}.record m
          set tree = case
            when public.nlevel(m.tree) = public.nlevel(_src) then _dst
            else _dst operator(public.||) public.subpath(m.tree, public.nlevel(_src), public.nlevel(m.tree) - public.nlevel(_src))
          end
          where _src operator(public.@>) m.tree
          returning m.id
        )
        select count(*) into _n from moved;
        return _n;
      end
      $function$;
