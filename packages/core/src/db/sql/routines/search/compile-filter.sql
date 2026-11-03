-- compile_filter turns a validated boolean-AST JSONB into a parenthesized
-- SQL predicate. Only compiler-owned structure (columns, operators, casts,
-- generated JSON paths) becomes SQL text; every leaf VALUE stays data,
-- referenced from the bound filter parameter via the runtime `_expr` path
-- (the caller passes `$1` for the root). Extension objects are public-only.
create function {{schema_ident}}.compile_filter
( _node jsonb
, _expr text
, _depth int default 1
)
returns text
language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        declare
          _keys text[];
          _key text;
          _out text;
        begin
          if _node is null then
            return 'true';
          end if;
          if _depth > 16 then
            raise exception 'filter nesting exceeds the maximum depth of 16'
              using errcode = 'invalid_parameter_value';
          end if;
          if jsonb_typeof(_node) is distinct from 'object' then
            raise exception 'filter node must be a json object'
              using errcode = 'invalid_parameter_value';
          end if;
          select array_agg(k) into _keys from jsonb_object_keys(_node) k;
          if _keys is null or array_length(_keys, 1) <> 1 then
            raise exception 'filter node must have exactly one key'
              using errcode = 'invalid_parameter_value';
          end if;
          _key := _keys[1];

          if _key in ('and', 'or') then
            if jsonb_typeof(_node -> _key) is distinct from 'array'
               or jsonb_array_length(_node -> _key) < 2 then
              raise exception '% requires at least two children', _key
                using errcode = 'invalid_parameter_value';
            end if;
            select '(' || string_agg
              ( {{schema_ident}}.compile_filter
                ( e.elem
                , format('(%s -> %L -> %s)', _expr, _key, e.ord - 1)
                , _depth + 1
                )
              , case _key when 'and' then ' and ' else ' or ' end
              order by e.ord
              ) || ')'
            into _out
            from jsonb_array_elements(_node -> _key) with ordinality e(elem, ord);
            return _out;
          elsif _key = 'not' then
            return '(not ' || {{schema_ident}}.compile_filter
              (_node -> 'not', format('(%s -> %L)', _expr, 'not'), _depth + 1) || ')';
          elsif _key = 'tree' then
            return format('coalesce((%s ->> %L)::public.ltree operator(public.@>) m.tree, false)', _expr, 'tree');
          elsif _key = 'lquery' then
            return format('coalesce(m.tree operator(public.~) (%s ->> %L)::public.lquery, false)', _expr, 'lquery');
          elsif _key = 'ltxtquery' then
            return format('coalesce(m.tree operator(public.@) (%s ->> %L)::public.ltxtquery, false)', _expr, 'ltxtquery');
          elsif _key = 'meta' then
            if jsonb_typeof(_node -> 'meta') is distinct from 'object'
               or _node -> 'meta' = '{}'::jsonb then
              raise exception 'meta filter must be a non-empty object'
                using errcode = 'invalid_parameter_value';
            end if;
            return format('coalesce(m.meta @> (%s -> %L), false)', _expr, 'meta');
          elsif _key = 'metaPredicate' then
            return format('coalesce(m.meta @@ (%s ->> %L)::jsonpath, false)', _expr, 'metaPredicate');
          elsif _key = 'temporalWithin' then
            return format('coalesce((%s ->> %L)::tstzrange @> m.temporal, false)', _expr, 'temporalWithin');
          elsif _key = 'temporalOverlaps' then
            return format('coalesce((%s ->> %L)::tstzrange && m.temporal, false)', _expr, 'temporalOverlaps');
          elsif _key = 'temporalBefore' then
            return format('coalesce(m.temporal << tstzrange((%1$s ->> %2$L)::timestamptz, (%1$s ->> %2$L)::timestamptz, ''[]''), false)', _expr, 'temporalBefore');
          elsif _key = 'temporalAfter' then
            return format('coalesce(m.temporal >> tstzrange((%1$s ->> %2$L)::timestamptz, (%1$s ->> %2$L)::timestamptz, ''[]''), false)', _expr, 'temporalAfter');
          elsif _key = 'temporalContains' then
            return format('coalesce(m.temporal @> (%s ->> %L)::timestamptz, false)', _expr, 'temporalContains');
          elsif _key = 'regexp' then
            return format('coalesce(m.content ~* (%s ->> %L), false)', _expr, 'regexp');
          end if;

          raise exception 'unknown filter key: %', _key
            using errcode = 'invalid_parameter_value';
        end;
        $function$;
