# Direct CLI

The compiled `searchgres` binary is an optional reference application over the
[core library](../reference/api.md). It talks directly to PostgreSQL; there is
no searchgres.js HTTP server to deploy. Install it using the
[installation guide](../installation.md), or build with `./bun run compile`.

## Configure one index

```sh
searchgres config
```

On a TTY, this runs an offline wizard. It writes a reviewable YAML config,
environment template, and (when requested) a private `.env`. It never contacts
the database/provider and never overwrites an existing config.

Noninteractive example:

```sh
searchgres config --config searchgres.yaml --schema docs \
  --embedding-model text-embedding-3-small --dimensions 1536 \
  --api-key-env OPENAI_API_KEY --tokenizer openai-cl100k-base --max-tokens 8191
```

A minimal config:

```yaml
version: 1
database:
  urlEnv: SEARCHGRES_DATABASE_URL
index:
  schema: docs
  dimensions: 1536
  vectorType: halfvec
  vectorIndex: hnsw
embedding:
  provider: openai-compatible
  model: text-embedding-3-small
  apiKeyEnv: OPENAI_API_KEY
  truncate:
    kind: tokens
    tokenizer: openai-cl100k-base
    maxTokens: 8191
worker:
  count: 1
  interval: 1s
  batchSize: 100
```

`index.vectorIndex` is `hnsw` (default) or `prism`. `prism` is experimental:
see [Indexes](indexes.md#vector-index-access-method-hnsw-vs-prism).

Set database/provider secrets in the environment or `.env`, not tool inputs or
command-line arguments. Config lookup is `--config`, then `SEARCHGRES_CONFIG`,
then `./searchgres.yaml`. YAML (`.yaml`/`.yml`) and JSON5 are supported.

By default `.env` next to the config is loaded without replacing existing
process environment values. Use `--env-file <path>` or `--no-env-file` to control
this; an explicit missing env file is an error.

### Provider and truncation

An OpenAI-compatible provider/model is required. Omit `baseUrl` for OpenAI, or
supply a complete API root such as `http://127.0.0.1:11434/v1` for Ollama.
`baseUrlEnv` is an alternative environment-variable reference, mutually
exclusive with `baseUrl`. `apiKeyEnv` is optional for local endpoints; without it
the SDK receives a harmless placeholder key. Configure proxies such as oMLX or
OpenRouter using the endpoint's OpenAI-compatible URL and model name.

The binary uses the AI SDK OpenAI embedding model. Correct endpoint configuration
and consistency of the model/truncation policy across all readers and workers
are the user's responsibility. Matching dimensions do not prove matching models.

`embedding.documentPrefix` and `embedding.queryPrefix` set literal text that is
put before record content and before `search --semantic` text when they are
embedded, for models that need task prefixes (for example
`documentPrefix: "search_document: "` and `queryPrefix: "search_query: "` for
Nomic models). Both default to `""`. Quote them in YAML to keep the trailing
space. They count toward the truncation budget, must be the same for every
process that uses the index, and a `documentPrefix` change needs a re-embed.
See [Document and query prefixes](embeddings.md#document-and-query-prefixes).

Truncation is supplied to core. Available modes are `none`, `characters`/`bytes`
with `max`, and `tokens` with `tokenizer`/`maxTokens`. Exact tokenizer presets:

- `openai-cl100k-base`
- `nomic-embed-text-v1.5`
- `nomic-modernbert-embed-base`

Tokenizers and assets are bundled and never downloaded at runtime. Tokenizer
threads start on first use; `threads: 0` runs inline. Their count is separate
from the embedding-worker count. Ordinary CRUD, full-text/filter search, and
queue inspection do not contact the provider. Provisioning needs no API key.

### Runtime defaults

`database.pool`: `max: 10`, `idleReap: 5m`, `maxLifetime: 0s`,
`connectTimeout: 30s`. `database.session`: `statementTimeout: 30s`,
`lockTimeout: 5s`, `transactionTimeout: 35s`,
`idleInTransactionSessionTimeout: 35s`. All are configurable.
`embedding.requestTimeout` defaults to `30s` per provider request. AI SDK retries
and multi-batch operations can take longer than one request timeout.

## Provisioning

```sh
searchgres init
searchgres init --if-not-exists
searchgres migrate
searchgres info
searchgres vector-index reindex --concurrently
searchgres destroy --yes
```

`init` first installs the required PostgreSQL extensions that are missing:
`vector`, `pg_textsearch`, and `ltree`, plus `pg_vectorsearch` when
`index.vectorIndex` is `prism`. It runs `CREATE EXTENSION ... WITH SCHEMA
public` for each missing extension. An extension that is already installed must
be in `public` and meet the minimum version in
[Installation](../installation.md#postgresql); `init` does not move or upgrade
it. `init --if-not-exists` skips this step when the schema already exists.

In the standard builds, `vector`, `pg_textsearch`, and `pg_vectorsearch` are
not trusted extensions, so `CREATE EXTENSION` for them needs a superuser.
`ltree` is trusted: a role with `CREATE` privilege on the database can install
it. Managed services can use different rules; check
`pg_available_extension_versions.trusted`. If the CLI role cannot install an
extension, `init` fails with error code `EXTENSION` (`permission_denied`). In
that case, an administrator installs the extensions in `public` first (for
example `create extension if not exists vector with schema public`), and `init`
then only verifies them. `pg_textsearch` must also be in
`shared_preload_libraries`.

`vector-index reindex` rebuilds the vector index (`--concurrently`,
`--lock-timeout`, `--statement-timeout`). A `prism` index needs one rebuild
after the first bulk load and embedding drain; see
[Use an experimental `prism` index](#use-an-experimental-prism-index).

`init --if-not-exists` accepts only an existing valid index with matching shape.
It never silently accepts an unrelated same-named schema. `migrate` upgrades an
existing configured index in place during a maintenance window without
contacting the embedding provider, and reports `{ schema, fromVersion, toVersion, applied }`.
Migration requires the schema owner role and is one-way (older `0.3.x` binaries
reject an upgraded schema). `destroy` drops exactly the configured schema.
Operational commands have no schema override;
`config --schema` only authors a config file. `info` reports index shape, model,
truncation, and queue status without credentials or endpoint URLs.

## Records and search

```sh
searchgres create --content 'Database indexes speed up queries' --tree docs.db --name intro
searchgres get docs.db intro
searchgres get docs.db intro --select id,versionHash,content:200
searchgres search --fulltext database
searchgres search --semantic 'speed up queries'
searchgres search --semantic 'speed up queries' --fulltext database
searchgres search --semantic 'speed up queries' --fulltext database --k 40
searchgres search --filter '(and (tree docs) (meta {"kind":"guide"}))' --select id,content:200
searchgres search --filter '(meta {"kind":"guide"})' --tree docs
searchgres update <id> --version-hash <current-hash> --meta '{"kind":"guide"}'
searchgres update docs.db intro --version-hash <current-hash> --content 'New text'
searchgres delete <id>
```

Create fails on conflict unless `--replace` or `--ignore` is explicit. `get`
and `update` address a record by `<id>` or by `<tree> <name>`. Update
requires a current version hash (`get ... --select versionHash` shows it); an
update by tree and name looks up the record first, and the version hash still
rejects a record that changed since you read it. `--meta` replaces all existing metadata (it
is not merged). `delete <id>` prints `{deleted: {id}}` and
`delete <tree> <name>` prints `{deleted: {tree, name}}`; a missing record is
`NOT_FOUND` (exit `2`). Pass
structured input to create with `--file`; update uses `--input` (inline, `@file`,
or `-`). No command accepts caller vectors. Semantic query text is embedded on
the host before querying PostgreSQL.

Tree commands: `tree [root]`, `list --lquery ...`, `count --tree ...` (or
`--lquery`/`--ltxtquery`), `move <source> <destination>`,
`copy <source> <destination>`, `delete --tree <path> --yes`. Tree mutations
support `--dry-run`.

YAML is the default display; use `--json`, or `--ndjson` for collection commands.
Dates are ISO strings. `--select` (on `search` and `get`) is local
presentation, not database projection. `get --select` accepts the same fields
as `search --select` except `score`.
Selected fields are printed in the order given (`contentLength` follows
`content` for a content range).
Filter flags (`--tree`, `--meta`, `--lquery`, and the others) combine with AND.
`--filter` or `--filter-file` can be used together with them, and the
expression is ANDed with the flags too. `--k` sets the RRF rank constant of a
hybrid search, like MCP `k`.
Use `<command> --help` for all flags. See the [filter grammar](../reference/filter-syntax.html).

### Import/export

```sh
searchgres import records.ndjson
searchgres import -r ./documents --tree docs
searchgres export records.ndjson --tree docs
```

Imports accept these input shapes:

| Format | Input |
| --- | --- |
| NDJSON | One record object per nonblank line. |
| JSON / YAML | One record object, an array of records, or an object with a `records` array. |
| Markdown | One record per file: the body is `content`; optional YAML frontmatter supplies other record fields. |

A record requires non-empty `content`. Optional fields are `id` (UUIDv7), `tree`
(raw dotted path, default root `""`), `name` (non-empty or `null`), `meta` (JSON
object), and `temporal` (`[instant]` or `[start, end]` with ISO timestamps).
Omit `temporal` when absent. Unknown record/frontmatter keys are rejected; put
application fields such as `title` under `meta`:

```markdown
---
tree: docs.db
name: indexes
meta:
  title: Database indexes
  kind: guide
---
Postgres indexes make database queries faster.
```

Plain Markdown without frontmatter is also accepted. `--tree` supplies a default
for records that omit a tree.

Imports write batches of at most 1,000 records, without HTTP request-byte limits.
Each batch is atomic, but the whole import is not: successful batches remain
committed if another fails. Conflicts fail the batch unless `--replace` or
`--ignore` is specified. `--dry-run` checks input shape without writing or
checking database conflicts; `--fail-fast` stops on the first failed file or
batch. Failed imports return nonzero.

Exports use keyset pagination, not a snapshot. They retain record IDs, content,
tree, name, metadata, and temporal values, but omit vectors, version fields,
creation/update timestamps, and queue state. Importing into a new index creates
fresh versions/timestamps and queues embeddings. This is a content-transfer
format, not a full backup; use [PostgreSQL backups](production.md#backups-and-recovery)
for recovery. Export owns `--format` (`ndjson`, `json`, `yaml`, `md`), not
display-format flags. Markdown export requires an output directory and writes
one `<id>.md` file per record.

## Embedding work

```sh
searchgres embeddings process
searchgres embeddings process --max-batches 1
searchgres embeddings process --max-duration 30s
searchgres embeddings worker --workers 4
searchgres embeddings status
searchgres embeddings failures --limit 100 --after <queue-id>
searchgres embeddings retry --queue-id <id> <id>
searchgres embeddings retry --all --yes
searchgres embeddings prune --older-than 7d --yes
```

`process` drains currently claimable work and exits, reporting `claimed`,
`embedded`, `failed`, `cancelled`, `remaining`, and `sampleError`. Reported
failures exit `1`; remaining work alone is not failure. Leased or delayed rows
may remain even if nothing is claimable. Limits and cancellation are checked
between batches. `sampleError` is `null`, or the first failure of the pass as
`{ code, message }` with only a safe failure class, for example
`Failed to generate embeddings (HTTP 404)`. The provider's own text stays in
PostgreSQL.

If the model returns vectors with the wrong number of dimensions, `process`
fails with `DIMENSION_MISMATCH` and exit `1`, and the rows of that batch fail
permanently (no retries). `worker` logs the error with `"workerStopped": true`,
and that worker stops; when all workers have stopped, the command exits `1`.
Fix the model or index configuration, then run
`searchgres embeddings retry --all --yes`.

`status` and the `queue` object in `info` make queue subsets explicit:

```json
{
  "pending": {
    "total": 3,
    "claimable": 1,
    "deferred": 2,
    "oldestAt": "2026-09-17T12:00:00.000Z"
  },
  "failed": { "terminal": 4 }
}
```

`pending.total` is all non-terminal work and always equals
`pending.claimable + pending.deferred`. Claimable rows may be claimed now;
deferred rows are protected by an active lease or retry delay. Terminal failures
are outside the pending total and remain until retried, superseded, or pruned.

After the final failed attempt, a row remains pending until its visibility
timeout expires and a subsequent worker poll or `process` invocation sweeps it
to terminal failure. Thus `failed.terminal` and `failures` can lag the failed
attempt. `status` and `info` only inspect the queue; they do not finalize rows.
See the [queue lifecycle details](embeddings.md#monitor-the-queue).

`worker` starts N concurrent core loops sharing one SQL pool, model, and
truncator. It is not N tokenizer threads. Default count is one (configurable);
zero is rejected for this command. Ordinary CLI commands never start workers.

Queue IDs are decimal bigint strings, not record UUIDs. Failure listing and
explicit retry batches are capped at 1,000. Failure listings redact raw provider
error text retained in PostgreSQL because it may contain secrets; they retain
queue/record IDs, attempt counts, and timestamps for diagnosis and retry.
`retry --all` performs one forward
paginated traversal and sums retried/skipped counts; it is not a snapshot and
does not repeatedly chase failures. Prune uses core's terminal-row retention
based on enqueue time. There is no prune dry-run API.

## Use an experimental `prism` index

`prism` is the `pg_vectorsearch` vector index access method. It is
experimental; read
[Vector index access method](indexes.md#vector-index-access-method-hnsw-vs-prism)
before you use it. A new `prism` index is built on an empty table, so it starts
with one list and must be rebuilt after the first load:

1. Set `index.vectorIndex: prism` in the config (or pass
   `--vector-index prism` to `searchgres config`).
2. Run `searchgres init`. It also installs `pg_vectorsearch` (see
   [Provisioning](#provisioning) for the privileges).
3. Import the records, for example `searchgres import -r ./documents --tree docs`.
4. Drain the embedding queue with `searchgres embeddings process` (or a
   worker). Run `searchgres embeddings status` until `pending.total` is `0`.
   Check `failed.terminal` too: those records have no vector, so semantic
   search cannot find them.
5. Run `searchgres vector-index reindex` once. It runs `ANALYZE` on the record
   table and then rebuilds the index, so the list count fits the current row
   count. Add `--concurrently` if the index must stay available to other
   sessions during the rebuild.
6. Evaluate the index with the SQL in
   [Evaluate and maintain a `prism` index](indexes.md#evaluate-and-maintain-a-prism-index).
   The CLI does not report vector index health.

A rebuild of a large table can take longer than the default session timeouts
(`database.session.statementTimeout: 30s`, `transactionTimeout: 35s`). Pass
`--statement-timeout` (for example `--statement-timeout 30m`) to give the
rebuild more time. The rebuild uses it as its statement and transaction
timeout.

If `init` reports `pg_vectorsearch` with reason `incomplete_setup`, a superuser
must run `select public.pg_vectorsearch_setup_pgvector_compat()`.

## Errors, shutdown, and security

Exit codes: `0` success; `2` when the request cannot succeed as written
(usage and input errors, plus deterministic record-state mismatches:
`NOT_FOUND`, `CONFLICT`, `STALE_VERSION`); `1` operational failures (database,
provider, configuration). Structured errors on stderr carry a stable code.

When stderr is not a terminal, every failure (including argument errors such
as an unknown option) is one JSON line:

```json
{"error":{"code":"INVALID_INPUT","message":"unknown option '--limt'\n(Did you mean --limit?)"}}
```

Validation failures can add `issues`, an array of `{code, path, message}`.
When stderr is a terminal, the same error is printed as text, with the
message's line breaks kept (for example, a filter error's caret diagram). When
the error has issues, one `  - path: message` line follows for each issue:

```text
error [INVALID_INPUT]: Invalid filter expression: --filter:1:20: expected `)` to close `tree`
(tree ignition.docs
                   ^
```

The exit codes are the same in both forms. `--help` and `--version` print to
stdout and exit `0`. Search validation messages and issue paths name the flag
(`--candidate-limit`), not the library option (`candidateLimit`); MCP tools
keep the library names.
Validation, record-state, index, extension, dimension, and timeout messages are
retained because they describe only the caller's own request or catalog facts.
Provider and driver messages are replaced by their code so remote text and
credentials never reach output. Where one is available, the output adds a
safe failure class instead: an HTTP status (`HTTP 404`), a SQLSTATE
(`SQLSTATE 28P01`), or a system error code (`ECONNREFUSED`).

Records are printed in the shape they are accepted: `temporal` is `null`, an
ISO `[instant]`, or an ISO `[start, end]` interval; dates are ISO strings.
The CLI never automatically replays a failed record/tree operation; embedding
queue and SDK retries remain core behavior.

SIGINT/Ctrl-C and SIGTERM stop new work and wait for active operations and worker
batches, then close tokenizers and SQL connections. After 60 seconds the binary
forces termination; unfinished mutations may have committed, and abandoned
worker claims recover through queue leases. Cancellation is not a rollback
promise.

Use a provisioning role (the schema owner) for `init`/`migrate`/`destroy` and
an appropriately restricted runtime role for normal CLI/MCP work. Both can use the same config by supplying a
different database URL environment value. Do not use superuser credentials for
an untrusted agent. See [production guidance](production.md).
