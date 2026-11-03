# Format 2: pre-extraction catalog baselines

These goldens were captured **before SQL extraction**, by calling the existing
`createIndex` with its embedded TypeScript DDL and schema-local routine builders.
They are not reconstructed from the extracted SQL and must not be regenerated
from that SQL to make an equivalence test pass.

Source: HEAD `d87afb6c6bdce0c0340124c98da0277d88de6219`.
`create-index.ts` and every `db/routines/*.ts` file were unchanged from that HEAD;
`provenance.json` records their SHA-256 hashes and the working-tree status.
The pre-existing uncommitted edits were the build qualification/Bun 1.4.4 work
(including build tests, SQL loader, package/version and documentation changes).
The new capture harness files also appear in the recorded status. No product
DDL was modified during capture.

## Cases and coverage

Each case has its own stable fixture containing the **input** config and catalog:

- `halfvec-default-4.json`: dimensions 4, all other options omitted.
- `vector-default-4.json`: dimensions 4, explicit `vector` storage.
- `vector-custom-8.json`: dimensions 8, `vector`, BM25 `simple` / `k1=1.7` /
  `b=0.5`, HNSW `m=8` / `efConstruction=40`.
- `halfvec-custom-8.json`: the same custom settings with `halfvec` storage.

The snapshots contain the schema comment and version value; all user columns
(including index and sequence columns), types, defaults, identity/generated
flags and nullability; constraints; index definitions, options and qualified
opclasses; full `pg_get_functiondef` output, original function source, arguments,
result, settings, security and execution properties; triggers; relation/type
and sequence definitions/ownership dependencies; and namespace object inventory.
Inheritance, rules and policies are included even though currently empty.

## PostgreSQL environment

Capture used `scripts/with-postgres.ts` and the repository's
`docker/Dockerfile.postgres`:

- PostgreSQL **18.6**, Debian trixie, UTF8, arm64.
- Base image `pgvector/pgvector:0.8.6-pg18-trixie`, resolved digest
  `sha256:78bf48b801e792f99e3ac62b5036fd3876e9be48afda16c1e331af1c75ceb2ff`.
- `vector` **0.8.6**, `pg_textsearch` **1.4.0**, `ltree` **1.3**, all in `public`.
- `pg_textsearch` is preloaded by that image.

The integration test requires major version **18**. It does **not** compare
server/extension patch versions: supported versions pass when their catalog
output is identical. `createIndex` retains responsibility for its normal
extension minimum-version checks. `provenance.json` is informational evidence,
not a version lock used by the test.

Catalog reads run in one repeatable-read, read-only transaction/connection with
`search_path=pg_catalog`, `timezone=UTC`, `datestyle=ISO, YMD`,
`intervalstyle=postgres`, `extra_float_digits=3`,
`standard_conforming_strings=on`, `quote_all_identifiers=off`, and
`bytea_output=hex`. These are transaction-local and do not change the caller's
connection settings. Names are ordered with `COLLATE "C"`; ordered catalog
arrays retain their stored order. Deparser calls use non-pretty output where
available. This fixes deparsing context rather than rewriting its result.

## Exclusions and normalization

The **only string replacement** is the exact, random concrete `sgtest_*` schema
name to `__searchgres_schema__`, including references inside function bodies.
No whitespace, quoting, comments, body indentation, SQL tokens, function
settings or extension version strings are rewritten. JSON formatting does not
change the decoded strings. The tests include a whitespace-only function-body
mutation to ensure it remains detectable.

OIDs, owners/owner-dependent ACLs, timestamps and table/sequence data are not
captured. The version **value** is the sole table-data exception; its `at`
timestamp is omitted. Physical/storage statistics and automatically named TOAST
relations in `pg_toast` are excluded. FK-generated internal trigger names embed
OIDs, so their names and corresponding name-bearing `pg_get_triggerdef` output
are omitted. Their stable relation, function, event, enabled/deferral state,
constraint, columns, arguments and multiplicity are still captured. User trigger
names and `pg_get_triggerdef` output are preserved exactly. Thus there is no
blanket normalization of OID-shaped numbers or generated names in SQL text.

## Running and deliberately recapturing

From the repository root (Node 22.18+ or 24):

```sh
./bun scripts/with-postgres.ts node --import ./scripts/sql-loader.mjs \
  --test packages/core/test/schema-format.integration.test.ts
```

Original capture command:

```sh
./bun scripts/with-postgres.ts node --import ./scripts/sql-loader.mjs \
  scripts/capture-schema-baseline.ts \
  --output packages/core/test/fixtures/schema-format-2 \
  --confirm-pre-extraction
```

Capture is a separate, explicit maintenance action, never part of tests. It
requires `TEST_DATABASE_URL`, the explicit output and confirmation flags, and
unmodified committed DDL. Writes are exclusive: existing fixtures are never
silently overwritten. To reproduce after extraction, use the old checkout as
source and a **new** output directory, for example:

```sh
./bun scripts/with-postgres.ts node --import ./scripts/sql-loader.mjs \
  scripts/capture-schema-baseline.ts \
  --source-root /path/to/old-searchgres-checkout \
  --output /tmp/searchgres-format-2-recapture \
  --confirm-pre-extraction
```

That checkout must have its dependencies available. The script imports its
`create-index.ts` directly; it does not contain an executable copy of the old
DDL. The capture owns only randomly named `sgtest_*` schemas, drops them in
`finally`, and closes its pool. `with-postgres.ts` owns and removes a unique
disposable container on an ephemeral loopback port; no existing user database
is involved.
