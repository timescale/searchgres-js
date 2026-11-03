-- ------------------------------------------------------------------------
-- create embedding queue table and its indexes
-- ------------------------------------------------------------------------
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
