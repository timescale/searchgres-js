--------------------------------------------------------------------------------
-- create record table and its indexes
--------------------------------------------------------------------------------
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

alter table {{schema_ident}}.record add constraint record_temporal_bounds_convention_check
check
(
  temporal is null
  or
  (
    (
      pg_catalog.lower(temporal) = pg_catalog.upper(temporal)
      and pg_catalog.lower_inc(temporal)
      and pg_catalog.upper_inc(temporal)
    )
    or
    (
      pg_catalog.lower(temporal) < pg_catalog.upper(temporal)
      and pg_catalog.lower_inc(temporal)
      and not pg_catalog.upper_inc(temporal)
    )
  )
);

create index record_meta_gin_idx on {{schema_ident}}.record using gin (meta);

create index record_temporal_gist_idx on {{schema_ident}}.record using gist (temporal)
where temporal is not null;

create index record_content_bm25_idx on {{schema_ident}}.record using bm25 (content)
with
( text_config = {{text_config_literal}}
, k1 = {{bm25_k1_number}}
, b = {{bm25_b_number}}
);

create index record_embedding_hnsw_idx on {{schema_ident}}.record using hnsw (embedding public.{{cosine_opclass_ident}})
with
( m = {{hnsw_m_int}}
, ef_construction = {{hnsw_ef_construction_int}}
);

create index record_tree_gist_idx on {{schema_ident}}.record using gist (tree);

create unique index record_tree_name_uidx on {{schema_ident}}.record (tree, name)
where name is not null;

--------------------------------------------------------------------------------
-- create embedding queue table and its indexes
--------------------------------------------------------------------------------
create table {{schema_ident}}.embedding_queue
( id bigint generated always as identity primary key
, record_id uuid not null references {{schema_ident}}.record(id) on delete cascade
, content_version integer not null
, visible_at timestamptz not null default pg_catalog.now()
, outcome text check (outcome is null or outcome in ('completed', 'failed', 'cancelled'))
, attempts integer not null default 0 check (attempts >= 0)
, last_error text
, created_at timestamptz not null default pg_catalog.now()
, updated_at timestamptz
);

create index embedding_queue_claim_idx on {{schema_ident}}.embedding_queue (visible_at)
where outcome is null;

create index embedding_queue_record_idx on {{schema_ident}}.embedding_queue (record_id, content_version desc)
where outcome is null;

create index embedding_queue_archive_idx on {{schema_ident}}.embedding_queue (created_at)
where outcome is not null;

create index embedding_queue_record_id_idx on {{schema_ident}}.embedding_queue (record_id);
