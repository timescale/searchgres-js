-- ------------------------------------------------------------------------
-- create record table and its indexes
-- ------------------------------------------------------------------------
create table {{schema_ident}}.record
( id uuid primary key default pg_catalog.uuidv7() check (pg_catalog.uuid_extract_version(id) = 7)
, content text not null
, meta jsonb not null default '{}'::jsonb check (pg_catalog.jsonb_typeof(meta) = 'object')
, tree public.ltree not null default ''::public.ltree
, name text
, temporal tstzrange
, embedding public.{{vector_type_ident}}({{dimensions_int}})
, content_version integer not null default 1 check (content_version > 0)
, version bigint not null default 1 check (version > 0)
, version_hash text not null
, created_at timestamptz not null default pg_catalog.now()
, updated_at timestamptz
);
