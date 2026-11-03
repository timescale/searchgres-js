create table {{schema_ident}}.version
( version text not null
, at timestamptz not null default pg_catalog.now()
);
