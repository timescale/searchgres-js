# Index SQL

SQL definitions for searchgres indexes use the Memory Engine and `pgai`
migration layout:

- `bootstrap/`: schema creation, index comment, `version` table and singleton
  index (`001_provision.sql`), and the `migration` ledger table
  (`002_migration.sql`).
- `incremental/`: numbered one-time migrations (`001_initial.sql`, …) executed
  in alphanumeric order and tracked by filename stem in
  `{{schema_ident}}.migration`. Released files are locked in
  `incremental/frozen.txt`; see [`incremental/README.md`](incremental/README.md).
- `idempotent/`: numbered repeatable trigger and routine files
  (`001_triggers.sql`, `002_records.sql`, `003_tree.sql`, `004_search.sql`)
  executed in alphanumeric order on every creation and migration pass; see
  [`idempotent/README.md`](idempotent/README.md).

`../definitions.ts` imports each file as text so the build embeds it directly.

## Placeholders

`../template.ts` prepares a closed context and substitutes `{{name}}` in a
single pass:

| Name | Available in | SQL fragment |
| --- | --- | --- |
| `schema_ident` | creation & migration | Quoted, validated schema identifier |
| `schema_comment_literal` | creation & migration | Quoted fixed index marker |
| `vector_type_ident` | creation & migration | Quoted `vector` or `halfvec` identifier |
| `dimensions_int` | creation & migration | Validated dimensions integer |
| `cosine_opclass_ident` | creation & migration | Quoted opclass identifier for the vector type |
| `bm25_index_literal` | creation & migration | Quoted `<schema>.record_content_bm25_idx` literal |
| `text_config_literal` | creation only | Catalog-resolved text config, quoted by PostgreSQL |
| `bm25_k1_number`, `bm25_b_number` | creation only | Validated numeric BM25 options |
| `hnsw_m_int`, `hnsw_ef_construction_int` | creation only | Validated integer HNSW options |

Literal fragments already include quotes; do not wrap them in another pair.
Extension objects remain qualified with literal `public`.
