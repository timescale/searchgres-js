-- ------------------------------------------------------------------------
-- create the regex-safety analyzer routine
-- ------------------------------------------------------------------------
-- Returns {"g":guard,"r":has_regex,"u":unguarded}. Used only for a
-- filter-only search to enforce that a regex is never the sole scan driver
-- and never appears under `not`. Mirrors `analyzeFilter` in `src/search.ts`,
-- which pre-validates library input; the two must implement identical rules
-- (this body is part of the immutable schema format, so a rule change here
-- needs a new format, while the TS copy can change freely).
create function {{schema_ident}}.analyze_filter
( _node jsonb
, _ranked boolean
)
returns jsonb
language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        declare
          _key text;
          _child jsonb;
          _g boolean := false;
          _r boolean := false;
          _u boolean := false;
          _any_guard boolean := false;
          _all_guard boolean := true;
          _any_regex boolean := false;
          _any_unguarded boolean := false;
        begin
          if _node is null then
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          end if;
          select k into _key from jsonb_object_keys(_node) k limit 1;

          if _key in ('and', 'or') then
            for _child in select * from jsonb_array_elements(_node -> _key) loop
              declare _a jsonb := {{schema_ident}}.analyze_filter(_child, _ranked);
              begin
                _any_guard := _any_guard or (_a ->> 'g')::boolean;
                _all_guard := _all_guard and (_a ->> 'g')::boolean;
                _any_regex := _any_regex or (_a ->> 'r')::boolean;
                _any_unguarded := _any_unguarded or (_a ->> 'u')::boolean;
              end;
            end loop;
            if _key = 'and' then
              return jsonb_build_object('g', _any_guard, 'r', _any_regex, 'u', _any_unguarded and not _any_guard);
            else
              return jsonb_build_object('g', _all_guard and not _any_regex, 'r', _any_regex, 'u', _any_unguarded);
            end if;
          elsif _key = 'not' then
            if ({{schema_ident}}.analyze_filter(_node -> 'not', _ranked) ->> 'r')::boolean and not _ranked then
              raise exception 'a regexp filter may not appear under not in a filter-only search'
                using errcode = 'invalid_parameter_value';
            end if;
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          elsif _key = 'regexp' then
            return jsonb_build_object('g', false, 'r', true, 'u', true);
          elsif _key = 'metaPredicate' then
            return jsonb_build_object('g', false, 'r', false, 'u', false);
          end if;
          return jsonb_build_object('g', true, 'r', false, 'u', false);
        end;
        $function$;
