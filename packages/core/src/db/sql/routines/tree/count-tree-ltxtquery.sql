create function {{schema_ident}}.count_tree(_query public.ltxtquery, _max_count bigint default null)
returns bigint
language sql stable security invoker
as $function$
        select pg_catalog.count(*) from
        (
          select 1 from {{schema_ident}}.record m
          where m.tree operator(public.@) _query
          limit _max_count
        ) t
      $function$;
