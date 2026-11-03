-- ------------------------------------------------------------------------
-- tree_view
-- ------------------------------------------------------------------------
-- Inclusive display tree rooted at `_base`. Unlike list_tree, this includes
-- the requested base itself (the empty ltree becomes the CLI's synthetic
-- `.` root) and bounds prefix expansion at `_levels` relative depth.
create function {{schema_ident}}.tree_view(_base public.ltree, _levels integer default null)
returns table (tree public.ltree, count bigint)
language sql stable security invoker
as $function$
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
        (
          public.nlevel(_base)
        , case when _levels is null then public.nlevel(matched.tree)
               else least(public.nlevel(matched.tree), public.nlevel(_base) + _levels)
          end
        ) i
        group by 1
        order by 1
      $function$;
