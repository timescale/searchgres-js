alter table {{schema_ident}}.version
  alter column version type bigint using version::bigint;

create table {{schema_ident}}.migration
( name text not null constraint migration_pkey primary key
, applied_at_version bigint not null
, applied_at timestamptz not null default pg_catalog.clock_timestamp()
);
