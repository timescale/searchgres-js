-- Deliberately no SET clause: these stable SQL reads must remain inlineable.
-- Qualified tables/operators keep them safe under an arbitrary caller path.
create function {{schema_ident}}.get_record_by_name(_tree public.ltree, _name text)
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
)
language sql stable security invoker
as $function$
        select
          m.id, m.content, m.meta, m.tree, m.temporal, m.name
        , (m.embedding is not null)
        , m.version, m.version_hash, m.created_at, m.updated_at
        from {{schema_ident}}.record m
        where m.tree operator(public.=) _tree and m.name operator(pg_catalog.=) _name
      $function$;
