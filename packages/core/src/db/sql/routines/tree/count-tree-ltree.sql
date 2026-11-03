-- ------------------------------------------------------------------------
-- count_tree (three explicit filter kinds)
-- ------------------------------------------------------------------------
-- `_max_count` bounds the scan; the TS layer passes max+1 so it can tell an
-- exact count from a capped one. `limit null` means no cap. These SQL `stable`
-- routines omit `set search_path` (a SET clause records proconfig, which
-- — though these are not inlineable, having a relation scan/subquery/aggregate
-- — needlessly costs a per-call GUC save/restore); every reference is fully
-- qualified so they are correct under any caller path.
create function {{schema_ident}}.count_tree(_tree public.ltree, _max_count bigint default null)
returns bigint
language sql stable security invoker
as $function$
        select pg_catalog.count(*) from
        (
          select 1 from {{schema_ident}}.record m
          where _tree operator(public.@>) m.tree
          limit _max_count
        ) t
      $function$;
