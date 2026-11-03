-- ------------------------------------------------------------------------
-- create search_records routine (filter-only, keyword, or semantic)
-- ------------------------------------------------------------------------
create function {{schema_ident}}.search_records
( _filter jsonb default null
, _fulltext text default null
, _vec public.{{vector_type_ident}}({{dimensions_int}}) default null
, _min_similarity float8 default null
, _limit bigint default 10
, _order text default 'desc'
, _after uuid default null
, _before uuid default null
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
, score float8
)
language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
        #variable_conflict use_column
        declare
          _where text;
          _score text;
          _order_by text;
          _extra text := '';
          _sql text;
          _lim bigint;
          _bm25q public.bm25query;
          _max_dist float8;
        begin
          if _fulltext is not null and _vec is not null then
            raise exception 'provide either _fulltext or _vec, not both'
              using errcode = 'invalid_parameter_value';
          end if;
          if _min_similarity is not null and _vec is null then
            raise exception '_min_similarity requires _vec'
              using errcode = 'invalid_parameter_value';
          end if;
          if _min_similarity is not null and not (_min_similarity between 0 and 1) then
            raise exception '_min_similarity must be between 0 and 1'
              using errcode = 'invalid_parameter_value';
          end if;
          if (_after is not null or _before is not null)
             and (_fulltext is not null or _vec is not null) then
            raise exception 'cursors are only valid for a filter-only search'
              using errcode = 'invalid_parameter_value';
          end if;

          _lim := greatest(least(coalesce(_limit, 10), 1000), 1);

          if _filter is null then
            _where := '$1 is null';
          else
            _where := {{schema_ident}}.compile_filter(_filter, '$1', 1);
            if _fulltext is null and _vec is null then
              perform 1 where ({{schema_ident}}.analyze_filter(_filter, false) ->> 'u')::boolean;
              if found then
                raise exception 'a regexp filter must be accompanied by an indexable filter (tree, lquery, ltxtquery, meta, or temporal)'
                  using errcode = 'invalid_parameter_value';
              end if;
            end if;
          end if;

          if _fulltext is not null then
            _bm25q := public.to_bm25query(_fulltext, {{bm25_index_literal}});
            _score := '-(m.content operator(public.<@>) $2) as score';
            _order_by := 'm.content operator(public.<@>) $2, m.id';
            _extra := 'and (m.content operator(public.<@>) $2) < 0';
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from {{schema_ident}}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter, _bm25q;

          elsif _vec is not null then
            -- iterative HNSW so filters do not shrink the result below the limit;
            -- strict_order keeps distance order for RRF ranks. Transaction-local.
            perform set_config('hnsw.iterative_scan', 'strict_order', true);
            _score := '1 - (m.embedding operator(public.<=>) $2) as score';
            _order_by := 'm.embedding operator(public.<=>) $2, m.id';
            _extra := 'and m.embedding is not null';
            if _min_similarity is not null then
              _max_dist := 1 - _min_similarity;
              _extra := _extra || format(' and (m.embedding operator(public.<=>) $2) <= %s::float8', _max_dist);
            end if;
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from {{schema_ident}}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter, _vec;

          else
            _score := '(-1)::float8 as score';
            if lower(coalesce(_order, 'desc')) = 'asc' then
              _order_by := 'm.id asc';
              if _after is not null then
                _extra := format('and m.id > %L::uuid', _after);
              elsif _before is not null then
                _extra := format('and m.id < %L::uuid', _before);
              end if;
            else
              _order_by := 'm.id desc';
              if _after is not null then
                _extra := format('and m.id < %L::uuid', _after);
              elsif _before is not null then
                _extra := format('and m.id > %L::uuid', _before);
              end if;
            end if;
            _sql := format($f$
              select m.id, m.content, m.meta, m.tree, m.temporal, m.name,
                     (m.embedding is not null) as has_embedding, m.version, m.version_hash,
                     m.created_at, m.updated_at, %s
              from {{schema_ident}}.record m
              where (%s) %s
              order by %s
              limit %s
            $f$, _score, _where, _extra, _order_by, _lim);
            return query execute _sql using _filter;
          end if;
        end;
        $function$;
