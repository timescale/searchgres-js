# Incremental SQL files

Each file in this directory runs once per index schema, whether the index is
created fresh or upgraded in place. Its filename stem (such as `001_initial`) is
recorded in `{{schema_ident}}.migration`.

Files run in alphanumeric order by filename (`NNN_name.sql`).

## Authoring rules

Do not rename or edit an incremental file after it ships in a release.
`frozen.txt` records the SHA-256 hash of every released file and `./bun run check`
verifies it. When cutting a release that adds a new incremental file, run
`./bun run freeze:sql` to verify existing entries and append the new hash. Use
`./bun run freeze:sql -- --force` only for a deliberate override.

Incremental files run before `../idempotent/`. On a fresh install, managed
triggers and routines do not exist yet while incrementals run. On an upgrade,
the prior version's triggers are still attached, and if versions were skipped,
intermediate releases' idempotent files have not run. Backfills must account for
both cases, for example by installing required trigger functions and triggers
explicitly before updating rows.

`create or replace function` cannot change return types, parameter names, or
argument types in place. Put explicit
`drop function if exists {{schema_ident}}.<name>(<arg_types>)` statements in an
incremental file with default `RESTRICT` behavior, and preserve any custom
ownership or restrictive `EXECUTE` grants. Keep sibling overloads of overloaded
functions such as `count_tree` intact.
