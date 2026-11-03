-- ------------------------------------------------------------------------
-- list_tree
-- ------------------------------------------------------------------------
-- For every record matching `_query`, emit each of its non-root ancestor
-- prefixes and count how many records fall under each. A matching record thus
-- contributes to every ancestor node, so counts are descendant totals, not
-- immediate-child counts. Ordered by tree for a stable listing.
--
-- SQL `stable`, single-`SELECT`, `security invoker`, and — like the record
-- reads — it omits `set search_path` so PostgreSQL can inline it. Everything
-- is fully qualified (table by schema, ltree ops/functions by `public`,
-- aggregate and set function by `pg_catalog`) to stay correct under any path.
create function {{schema_ident}}.list_tree(_query public.lquery)
returns table (tree public.ltree, count bigint)
language sql stable security invoker
as $function$
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
      $function$;
