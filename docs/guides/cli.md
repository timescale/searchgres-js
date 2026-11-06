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
searchgres vector-index stats
searchgres vector-index reindex --concurrently
searchgres destroy --yes
```

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
searchgres search --fulltext database
searchgres search --semantic 'speed up queries'
searchgres search --semantic 'speed up queries' --fulltext database
searchgres search --filter '(and (tree docs) (meta {"kind":"guide"}))' --select id,content:200
searchgres update <id> --version-hash <current-hash> --meta '{"kind":"guide"}'
searchgres delete <id>
```

Create fails on conflict unless `--replace` or `--ignore` is explicit. Update
requires a current version hash; metadata is replaced, not merged. Pass
structured input to create with `--file`; update uses `--input` (inline, `@file`,
or `-`). No command accepts caller vectors. Semantic query text is embedded on
the host before querying PostgreSQL.

Tree commands: `tree [root]`, `list --lquery ...`, `count --tree ...` (or
`--lquery`/`--ltxtquery`), `move <source> <destination>`,
`copy <source> <destination>`, `delete --tree <path> --yes`. Tree mutations
support `--dry-run`.

YAML is the default display; use `--json`, or `--ndjson` for collection commands.
Dates are ISO strings. `--select` is local presentation, not database projection.
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
`embedded`, `failed`, `cancelled`, and `remaining`. Reported failures exit `1`;
remaining work alone is not failure. Leased or delayed rows may remain even if
nothing is claimable. Limits and cancellation are checked between batches.

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

## Errors, shutdown, and security

Exit codes: `0` success; `2` when the request cannot succeed as written
(usage and input errors, plus deterministic record-state mismatches:
`NOT_FOUND`, `CONFLICT`, `STALE_VERSION`); `1` operational failures (database,
provider, configuration). Structured errors on stderr carry a stable code.
Validation and record-state messages are retained because they describe only
the caller's own request; provider and driver messages are replaced by their
code so remote text and credentials never reach output.

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
