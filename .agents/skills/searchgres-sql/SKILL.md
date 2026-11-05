---
name: searchgres-sql
description: Author, modify, and migrate embedded PostgreSQL definitions in searchgres (`packages/core/src/db/sql/`). Use whenever editing `.sql` files, changing schema-local routines, views, triggers, tables, or indexes, adding an incremental schema migration, bumping `SCHEMA_FORMAT_VERSION`, freezing SQL hashes, or writing upgrade and catalog comparison tests.
---

# searchgres SQL Development

Persisted PostgreSQL DDL, triggers, views, and routines for a searchgres index live in embedded `.sql` files under `packages/core/src/db/sql/`. Runtime parameterized queries live in TypeScript under `packages/core/src/db/`.

Read the companion [`sql-formatting`](../sql-formatting/SKILL.md) skill before authoring or editing SQL. Every `.sql` file in `packages/core/src/db/sql/` and inline SQL query in `packages/core/src/` follows that formatting style.

## Directory layout and execution order

Both `createIndex` and `migrateIndex` execute the embedded SQL definitions registered in `packages/core/src/db/definitions.ts`:

```text
packages/core/src/db/sql/
├── bootstrap/
│   ├── 001_provision.sql     # Creates <schema>, <schema>.version (bigint), <schema>.migration
│   └── 002_migration.sql     # Format-2 adoption: alters version.version to bigint, creates migration
├── incremental/
│   ├── 001_initial.sql       # Tables, constraints, and indexes (record, embedding_queue)
│   └── frozen.txt            # SHA-256 hashes of released incremental files
└── idempotent/
    ├── 001_triggers.sql      # Trigger functions + DROP TRIGGER IF EXISTS / CREATE TRIGGER
    ├── 002_records.sql       # batch_upsert, get_record*, patch_record, delete_record*
    ├── 003_tree.sql          # tree_view, move_tree, copy_tree, delete_tree, count_tree*, list_tree
    └── 004_search.sql        # analyze_filter, compile_filter, search_records, hybrid_search_records
```

Execution order inside the per-schema advisory lock (`advisoryLockKey(schema)`) and transaction-local `search_path = pg_catalog, public, pg_temp`:

1. **Bootstrap**:
   - `createIndex` runs `bootstrap/001_provision.sql`.
   - `migrateIndex` on a format-2 schema runs `bootstrap/002_migration.sql` and records `('001_initial', 2)` in `<schema>.migration` without replaying `001_initial.sql`.
2. **Incremental (`incremental/NNN_<name>.sql`)**:
   - Sorted by numeric prefix (`001_`, `002_`, ...). The ledger key in `<schema>.migration.name` is the filename without `.sql` (derived by `migrationNameFromFile`).
   - `createIndex` runs all incremental files in order and records each with `applied_at_version = SCHEMA_FORMAT_VERSION`.
   - `migrateIndex` runs only incremental files whose name is not yet in `<schema>.migration`.
3. **Idempotent (`idempotent/NNN_<topic>.sql`)**:
   - Every `createIndex` call and every `migrateIndex` call (even when `status === "up_to_date"`) runs all files in `idempotent/` in numeric order.
4. **Version marker**:
   - Updates `<schema>.version.version` to `SCHEMA_FORMAT_VERSION` (`bigint`) and refreshes the `COMMENT ON SCHEMA`.

## Choosing the right SQL bucket

### 1. Routine, view, or trigger body change (same signature)
When parameter names, parameter types, and return types are unchanged:
- Edit the corresponding `packages/core/src/db/sql/idempotent/00N_<topic>.sql` file in place.
- Do **not** add an incremental migration file.
- Bump `SCHEMA_FORMAT_VERSION` in `packages/core/src/version.ts` only if existing deployments should see an explicit version transition when running `migrateIndex` / `searchgres migrate`.

### 2. Table, column, constraint, index, or data backfill change
Every stateful change must go in a new `packages/core/src/db/sql/incremental/NNN_<name>.sql` file so both `createIndex` (which runs `001_initial.sql` followed by `002_...`, `003_...`) and `migrateIndex` converge to the exact same catalog:
1. Never edit a file listed in `packages/core/src/db/sql/incremental/frozen.txt`.
2. Add `packages/core/src/db/sql/incremental/NNN_<name>.sql` with the next 3-digit prefix.
3. Import and append the file to `INCREMENTAL_SQL_DEFINITIONS` in `packages/core/src/db/definitions.ts`.
4. Increment `SCHEMA_FORMAT_VERSION` in `packages/core/src/version.ts`.
5. Update any affected routines in `packages/core/src/db/sql/idempotent/`.

### 3. Routine parameter list or return type change
`CREATE OR REPLACE FUNCTION` cannot change parameter types, defaults when removing parameters, or return types (`OUT` columns). Because `idempotent/*.sql` runs *after* `incremental/*.sql`, handle signature changes across both directories:

1. **In the new `incremental/NNN_<name>.sql`**, capture any custom ACL (`pg_proc.proacl`) on the old signature into a `pg_temp` table before dropping the old function:
   ```sql
   create temporary table if not exists _searchgres_saved_proacl
   (
     routine_name text primary key
   , proacl aclitem[]
   ) on commit drop;

   insert into pg_temp._searchgres_saved_proacl (routine_name, proacl)
   select
     p.proname
   , p.proacl
   from pg_catalog.pg_proc as p
   inner join pg_catalog.pg_namespace as n
     on n.oid = p.pronamespace
   where n.nspname = {{schema_literal}}
     and p.proname = 'my_routine'
     and p.proacl is not null
   on conflict (routine_name) do update
   set proacl = excluded.proacl;

   drop function {{schema_ident}}.my_routine(pg_catalog.uuid);
   ```
2. **In `idempotent/00N_<topic>.sql`**, update `create or replace function {{schema_ident}}.my_routine(...)` to the new signature, and if an incremental migration drops that function, add a repeatable `do $do$ ... $do$` block after the function definition that replays any saved grants from `pg_temp._searchgres_saved_proacl` via `pg_catalog.aclexplode(saved.proacl)` so non-owner roles do not lose `EXECUTE` privileges across `migrateIndex`.

## Template placeholders and qualification rules

### Template tokens (`packages/core/src/db/template.ts`)
SQL files are rendered via `renderSqlTemplate`, which accepts only branded `SqlFragment` values (`sqlIdentifier`, `sqlLiteral`, `sqlNumber`). Both `createIndex` and `migrateIndex` supply the full `ProvisioningSqlContext` (in `migrateIndex`, `readIndexShape` reconstructs the index's vector and BM25 settings from `pg_catalog`):

| Token | Kind | Example rendered value |
| --- | --- | --- |
| `{{schema_ident}}` | identifier | `"docs_index"` |
| `{{schema_literal}}` | string literal | `'docs_index'` |
| `{{schema_version_literal}}` | string literal | `'3'` |
| `{{vector_column_type}}` | SQL fragment | `public.halfvec(1536)` or `public.vector(1536)` |
| `{{hnsw_opclass}}` | SQL fragment | `public.halfvec_cosine_ops` or `public.vector_cosine_ops` |
| `{{hnsw_m}}` | number | `16` |
| `{{hnsw_ef_construction}}` | number | `64` |
| `{{bm25_text_config}}` | identifier/qualified | `pg_catalog."english"` |
| `{{bm25_text_config_literal}}` | string literal | `'english'` |
| `{{bm25_k1}}` | number | `1.2` |
| `{{bm25_b}}` | number | `0.75` |

### Qualification invariants
- **Schema objects**: Always qualify index tables, views, and routines with `{{schema_ident}}.` (never rely on `search_path` containing the index schema).
- **Extensions (`vector`, `pg_textsearch`, `ltree`)**: Always qualify extension types, casts, functions, opclasses, and operators with `public.`:
  - Types/casts: `public.ltree`, `public.lquery`, `public.ltxtquery`, `public.bm25vector`, `{{vector_column_type}}`.
  - Functions: `public.subltree(...)`, `public.nlevel(...)`, `public.subpath(...)`, `public.text2ltree(...)`, `public.to_bm25query(...)`.
  - Operators: `operator(public.<=>)`, `operator(public.<@>)`, `operator(public.<@)`, `operator(public.@>)`, `operator(public.~)`, `operator(public.@)`, `operator(public.||)`.
- **PostgreSQL built-ins**: Qualify catalog tables and built-in types/functions with `pg_catalog.` where resolution matters (`pg_catalog.uuid`, `pg_catalog.timestamptz`, `pg_catalog.jsonb`, `pg_catalog.text`, `pg_catalog.int4`, `pg_catalog.int8`, `pg_catalog.float8`, `pg_catalog.bool`).
- **Access methods and GUCs**: Keep index access methods (`using hnsw`, `using bm25`, `using gist`, `using gin`) and `set local` GUC names (`hnsw.iterative_scan`, `pg_textsearch.default_limit`) bare.
- **Security**: All schema-local functions are `security invoker`.

## Safe data backfills on `<schema>.record`

`<schema>.record` has load-bearing triggers installed by `idempotent/001_triggers.sql`:
- `record_integrity_trigger` (`before insert or update`): rejects mutations to `id` and `created_at`, validates `name`, `content`, and `temporal`, and on `UPDATE` increments `version` and sets `updated_at = clock_timestamp()` whenever non-embedding columns change.
- `record_embedding_input_enqueue_trigger` (`before update`): increments `embedding_version`, clears `embedding = null`, and enqueues a job in `<schema>.embedding_queue` when `content` changes without a new `embedding`.

When an incremental migration backfills `<schema>.record` and must preserve logical `version`, `updated_at`, `embedding`, and `embedding_version`:
```sql
alter table {{schema_ident}}.record
  disable trigger record_integrity_trigger;

alter table {{schema_ident}}.record
  disable trigger record_embedding_input_enqueue_trigger;

update {{schema_ident}}.record
set ...;

alter table {{schema_ident}}.record
  enable trigger record_embedding_input_enqueue_trigger;

alter table {{schema_ident}}.record
  enable trigger record_integrity_trigger;
```

## SQL formatting

Load [`../sql-formatting/SKILL.md`](../sql-formatting/SKILL.md) and [`../sql-formatting/references/examples.md`](../sql-formatting/references/examples.md) when writing or editing SQL.

## Verification and freezing workflow

1. **While iterating (before freezing)**:
   Run `./bun run check:sql` and `./bun run --filter searchgres test:unit`.
   `check:sql` verifies that every hash in `packages/core/src/db/sql/incremental/frozen.txt` still matches its file and that any new `incremental/NNN_*.sql` files appear *after* the frozen prefix, allowing you to iterate on a new migration before freezing it.
2. **Run database and upgrade tests**:
   ```sh
   ./bun scripts/with-postgres.ts ./bun run --filter searchgres test:db
   ```
   Key suites in `packages/core/test/upgrade/`:
   - `schema-format.integration.test.ts`: provisions a real `v0.3.2` format-2 index (`git archive v0.3.2`), runs `migrateIndex`, and compares the migrated schema against a fresh `createIndex` schema via `schemaCatalog(sql, schema)` across `vector`/`halfvec` and default/custom HNSW+BM25 settings.
   - `upgrade.integration.test.ts`: verifies data/queue preservation, repeatability, skipped-version upgrades, trigger-aware backfills, `proacl` grant preservation, `search_path` isolation, rollback, `pg_locks` concurrency, and `pg_dump`/`psql` restore.
3. **Freeze the new incremental migration before opening/merging the PR**:
   ```sh
   ./bun run freeze:sql
   ./bun run check:sql
   ```
   `./bun run freeze:sql` verifies existing entries in `frozen.txt` and appends SHA-256 hashes for new trailing `incremental/NNN_*.sql` files. Never run `freeze-sql.ts --force` on a migration that has already shipped in a release.
