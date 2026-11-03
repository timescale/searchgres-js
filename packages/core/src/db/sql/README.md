# Index definitions

These files are the authored source for persisted index objects. Each file is
one execution unit, imported as text by `../definitions.ts`; its manifest controls
dependency order and preserves the existing SQL span names. There is no runtime
filesystem loading or semicolon splitting.

## Placeholders

`../template.ts` prepares a closed context and substitutes `{{name}}` once:

| Name | SQL fragment |
| --- | --- |
| `schema_ident` | One quoted, validated schema identifier |
| `schema_comment_literal` | Quoted fixed index marker |
| `vector_type_ident` | Quoted `vector` or `halfvec` identifier |
| `dimensions_int` | Validated dimensions integer |
| `cosine_opclass_ident` | Quoted opclass identifier for the vector type |
| `text_config_literal` | Catalog-resolved text configuration, quoted by PostgreSQL |
| `bm25_k1_number`, `bm25_b_number` | Validated numeric options |
| `hnsw_m_int`, `hnsw_ef_construction_int` | Validated integer options |
| `bm25_index_literal` | Quoted string containing the schema/index reference |

Literal fragments already include quotes; do not wrap them in another pair.
Extension qualification remains literal `public`, for example:

```sql
embedding public.{{vector_type_ident}}({{dimensions_int}})
```

No expressions, loops, includes, signature directives, raw caller SQL, or record
values. Unknown, missing, and malformed placeholders fail before execution of
that definition. A substituted literal containing `{{...}}` remains data and is
not rendered again.

## Format 2 is unchanged

These are creation definitions, **not migrations**. `createIndex` still refuses
an existing schema. Function bodies intentionally retain their original source
indentation/whitespace; the pre-extraction catalog goldens verify exact bodies,
signatures, settings and all other persisted objects. Changes to persisted
behavior still require a new format/rebuild until migration support is designed
and implemented separately.

Ordinary parameterized runtime queries, preflight, transactions, locking,
timeouts and the bound version-marker insert remain in TypeScript.
