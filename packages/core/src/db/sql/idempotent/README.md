# Idempotent SQL files

This directory holds repeatable SQL definitions for managed triggers and
schema-local routines. Every file here runs on index creation and on every
`migrateIndex` pass, after all pending incremental migrations finish.

Files run in alphanumeric order by filename (`NNN_name.sql`). Number prefixes
must follow dependency order, such as trigger functions before triggers and
filter helpers before search routines.

## Authoring rules

Every script in this directory must be safe to run multiple times, such as
`create or replace` statements and idempotent `do` blocks. Put one-time table or
index creation and data backfills in `../incremental/`.

Changing a function's parameter names, argument types, or return type requires
an explicit `drop function if exists {{schema_ident}}.<name>(<old_arg_types>)`
in a new `../incremental/` migration so upgrades do not fail with `42P13` or
leave a stale overload behind. `count_tree` has three overloads (`ltree`,
`lquery`, `ltxtquery`); keep all three signatures explicit.

Because idempotent files render during both creation and migration, they may
only use variables present in `migrationSqlContext` (`{{schema_ident}}`,
`{{vector_type_ident}}`, `{{dimensions_int}}`, `{{cosine_opclass_ident}}`,
`{{bm25_index_literal}}`).
