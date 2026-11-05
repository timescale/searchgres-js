--------------------------------------------------------------------------------
-- compile_filter
--------------------------------------------------------------------------------
-- compile_filter turns a validated boolean-AST JSONB into a parenthesized
-- SQL predicate. Only compiler-owned structure (columns, operators, casts,
-- generated JSON paths) becomes SQL text; every leaf VALUE stays data,
-- referenced from the bound filter parameter via the runtime `_expr` path
-- (the caller passes `$1` for the root). Extension objects are public-only.
create or replace function {{schema_ident}}.compile_filter
( _node jsonb
, _expr text
, _depth int default 1
)
returns text
as $func$
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
      or jsonb_array_length(_node -> _key) < 2
    then
      raise exception '% requires at least two children', _key
        using errcode = 'invalid_parameter_value';
    end if;
    select
      '('
      || string_agg
      ( {{schema_ident}}.compile_filter
        ( e.elem
        , format('(%s -> %L -> %s)', _expr, _key, e.ord - 1)
        , _depth + 1
        )
      , case _key when 'and' then ' and ' else ' or ' end
      order by e.ord
      )
      || ')'
    into _out
    from jsonb_array_elements(_node -> _key) with ordinality e(elem, ord);
    return _out;
  elsif _key = 'not' then
    return
      '(not '
      || {{schema_ident}}.compile_filter
      ( _node -> 'not'
      , format('(%s -> %L)', _expr, 'not')
      , _depth + 1
      )
      || ')';
  elsif _key = 'tree' then
    return format('coalesce((%s ->> %L)::public.ltree operator(public.@>) m.tree, false)', _expr, 'tree');
  elsif _key = 'lquery' then
    return format('coalesce(m.tree operator(public.~) (%s ->> %L)::public.lquery, false)', _expr, 'lquery');
  elsif _key = 'ltxtquery' then
    return format('coalesce(m.tree operator(public.@) (%s ->> %L)::public.ltxtquery, false)', _expr, 'ltxtquery');
  elsif _key = 'meta' then
    if jsonb_typeof(_node -> 'meta') is distinct from 'object'
      or _node -> 'meta' = '{}'::jsonb
    then
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
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- analyze_filter
--------------------------------------------------------------------------------
-- Returns {"g":guard,"r":has_regex,"u":unguarded}. Used only for a
-- filter-only search to enforce that a regex is never the sole scan driver
-- and never appears under `not`. Mirrors `analyzeFilter` in `src/search.ts`,
-- which pre-validates library input; the two must implement identical rules.
create or replace function {{schema_ident}}.analyze_filter
( _node jsonb
, _ranked boolean
)
returns jsonb
as $func$
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
      declare
        _a jsonb := {{schema_ident}}.analyze_filter(_child, _ranked);
      begin
        _any_guard := _any_guard or (_a ->> 'g')::boolean;
        _all_guard := _all_guard and (_a ->> 'g')::boolean;
        _any_regex := _any_regex or (_a ->> 'r')::boolean;
        _any_unguarded := _any_unguarded or (_a ->> 'u')::boolean;
      end;
    end loop;
    if _key = 'and' then
      return jsonb_build_object
      ( 'g', _any_guard
      , 'r', _any_regex
      , 'u', _any_unguarded and not _any_guard
      );
    else
      return jsonb_build_object
      ( 'g', _all_guard and not _any_regex
      , 'r', _any_regex
      , 'u', _any_unguarded
      );
    end if;
  elsif _key = 'not' then
    if ({{schema_ident}}.analyze_filter(_node -> 'not', _ranked) ->> 'r')::boolean
      and not _ranked
    then
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
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- search_records (filter-only, keyword, or semantic)
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.search_records
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
as $func$
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
    and (_fulltext is not null or _vec is not null)
  then
    raise exception 'cursors are only valid for a filter-only search'
      using errcode = 'invalid_parameter_value';
  end if;

  _lim := greatest(least(coalesce(_limit, 10), 1000), 1);

  if _filter is null then
    _where := '$1 is null';
  else
    _where := {{schema_ident}}.compile_filter(_filter, '$1', 1);
    if _fulltext is null and _vec is null then
      perform 1
      where ({{schema_ident}}.analyze_filter(_filter, false) ->> 'u')::boolean;
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
    _sql := format
    ( $f$
        select
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
        , %s
        from {{schema_ident}}.record m
        where (%s) %s
        order by %s
        limit %s
      $f$
    , _score
    , _where
    , _extra
    , _order_by
    , _lim
    );
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
    _sql := format
    ( $f$
        select
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
        , %s
        from {{schema_ident}}.record m
        where (%s) %s
        order by %s
        limit %s
      $f$
    , _score
    , _where
    , _extra
    , _order_by
    , _lim
    );
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
    _sql := format
    ( $f$
        select
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
        , %s
        from {{schema_ident}}.record m
        where (%s) %s
        order by %s
        limit %s
      $f$
    , _score
    , _where
    , _extra
    , _order_by
    , _lim
    );
    return query execute _sql using _filter;
  end if;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;

--------------------------------------------------------------------------------
-- hybrid_search_records (RRF over both arms)
--------------------------------------------------------------------------------
create or replace function {{schema_ident}}.hybrid_search_records
( _filter jsonb default null
, _fulltext text default null
, _vec public.{{vector_type_ident}}({{dimensions_int}}) default null
, _min_similarity float8 default null
, _k float8 default 60.0
, _candidate_limit bigint default 30
, _fulltext_weight float8 default 1.0
, _semantic_weight float8 default 1.0
, _limit bigint default 10
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
as $func$
#variable_conflict use_column
declare
  _k_eff float8;
  _lim bigint;
  _cand bigint;
  _fw float8;
  _sw float8;
begin
  if _fulltext is null then
    raise exception '_fulltext must not be null'
      using errcode = 'invalid_parameter_value';
  end if;
  if _vec is null then
    raise exception '_vec must not be null'
      using errcode = 'invalid_parameter_value';
  end if;
  _k_eff := greatest(coalesce(_k, 60.0), 0.0);
  _lim := greatest(least(coalesce(_limit, 10), 1000), 1);
  _cand := greatest(least(coalesce(_candidate_limit, 30), 1000), _lim);
  _fw := greatest(least(coalesce(_fulltext_weight, 1.0), 1.0), 0.0);
  _sw := greatest(least(coalesce(_semantic_weight, 1.0), 1.0), 0.0);

  return query
  select
    coalesce(f.id, s.id) as id
  , coalesce(f.content, s.content) as content
  , coalesce(f.meta, s.meta) as meta
  , coalesce(f.tree, s.tree) as tree
  , coalesce(f.temporal, s.temporal) as temporal
  , coalesce(f.name, s.name) as name
  , coalesce(f.has_embedding, s.has_embedding) as has_embedding
  , coalesce(f.version, s.version) as version
  , coalesce(f.version_hash, s.version_hash) as version_hash
  , coalesce(f.created_at, s.created_at) as created_at
  , coalesce(f.updated_at, s.updated_at) as updated_at
  ,   coalesce(_fw / (_k_eff + f.rank), 0.0)
    + coalesce(_sw / (_k_eff + s.rank), 0.0) as score
  from
  (
    select
      row_number() over (order by r.score desc, r.id) as rank
    , r.*
    from {{schema_ident}}.search_records
    ( _filter => _filter
    , _fulltext => _fulltext
    , _limit => _cand
    ) r
  ) f
  full outer join
  (
    select
      row_number() over (order by r.score desc, r.id) as rank
    , r.*
    from {{schema_ident}}.search_records
    ( _filter => _filter
    , _vec => _vec
    , _min_similarity => _min_similarity
    , _limit => _cand
    ) r
  ) s
    on f.id = s.id
  order by score desc, id
  limit _lim;
end;
$func$ language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
;
