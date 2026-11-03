-- ------------------------------------------------------------------------
-- create hybrid_search_records routine (RRF over both arms)
-- ------------------------------------------------------------------------
create function {{schema_ident}}.hybrid_search_records
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
language plpgsql stable security invoker
set search_path to pg_catalog, public, pg_temp
as $function$
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
            select row_number() over (order by r.score desc, r.id) as rank, r.*
            from {{schema_ident}}.search_records
              (_filter => _filter, _fulltext => _fulltext, _limit => _cand) r
          ) f
          full outer join
          (
            select row_number() over (order by r.score desc, r.id) as rank, r.*
            from {{schema_ident}}.search_records
              (_filter => _filter, _vec => _vec, _min_similarity => _min_similarity, _limit => _cand) r
          ) s on f.id = s.id
          order by score desc, id
          limit _lim;
        end;
        $function$;
