--------------------------------------------------------------------------------
-- create schema and version marker table
--------------------------------------------------------------------------------
create schema {{schema_ident}};

-- Stamp the schema so openIndex/dropIndex can tell a searchgres index from
-- a caller schema that merely contains similarly named tables. COMMENT is a
-- utility statement and cannot take bind parameters, so the fixed constant
-- is inlined as a pre-quoted literal.
comment on schema {{schema_ident}} is {{schema_comment_literal}};

create table {{schema_ident}}.version
( version bigint not null
, at timestamptz not null default pg_catalog.now()
);

create unique index version_singleton_idx on {{schema_ident}}.version ((true));
