# Development

The project brand is `searchgres.js`; the npm package and CLI executable remain
`searchgres`. Keep runtime identifiers (configuration, MCP tools, telemetry, and
database format/locks) separate from display branding.

## Requirements and toolchain

Use the repository's pinned `./bun` wrapper for all workspace commands. It
fetches the pinned Bun into ignored `download/` on first use. To change versions,
update `version=` in `./bun` and the tag in `docker/Dockerfile.cli` together.
Node 22.18+ is required for core's Node tests. Docker and Compose 2.20+ are
required for database/evaluation checks.

```sh
./bun install
```

## Workspace and product boundaries

| Package | Responsibility |
| --- | --- |
| `packages/core` | Published `searchgres` library, Node/Bun-compatible ESM. |
| `packages/cli` | Private Bun source for one compiled `searchgres` binary: direct DB commands, provisioning, workers, MCP stdio, config, filter DSL, presentation, tokenizers. |

Core never depends on the CLI. The CLI calls core directly and owns its pools,
provider credentials, and lifecycle. There is no server/client/protocol package.
Core's `Truncator` API stays in core; model-pinned tokenizer assets and worker
threads live under `packages/cli`. Biome keeps runtime-specific imports/globals
out of core. CLI code can use Bun APIs.

## Checks

```sh
./bun run check        # grammar freshness, types, lint, unit tests
./bun run check:full   # above plus all database and compiled-binary tests
./bun run compile
./bun run bench:startup
```

`check:full` uses `scripts/with-postgres.ts` to build the PostgreSQL 18 image and
create a unique disposable container on an ephemeral loopback port. It passes
`TEST_DATABASE_URL` to tests and removes only its own container. It does not
replace a local `pg:up` database or require port 5432 to be unused.

For a database you operate yourself:

```sh
./bun run pg:up
./bun run test:db
./bun run --filter searchgres test:db
./bun run --filter @searchgres/cli test:db  # compile first
./bun run pg:rm
```

Core tests retain Node compatibility. CLI unit tests use Bun. Direct integration
tests use PostgreSQL plus a deterministic fake OpenAI-compatible endpoint and
exercise the compiled CLI and every MCP tool. The opt-in Compose smoke uses a
real Ollama model.

Cross-package sequencing stays in root `package.json`: build core before CLI.
Package scripts do not call other packages. Avoid wildcard orchestration that
continues downstream after a dependency failed. The package-local `dist/`
contains implementation build output, not a published CLI API.

## Core build and SQL text imports

Core's build runs `scripts/build-core.ts`: TypeScript emits declarations with
`stripInternal`, then pinned Bun bundles `src/index.ts` into Node-targeted ESM
with dependencies external and a linked source map containing sources. The build
clears stale output and removes partial output on failure. Core's prepack hook
rebuilds before staging legal files, so packing does not reuse stale JavaScript.
Consumers do not need Bun, a loader, or runtime access to source SQL files.

SQL authoring uses static text imports and the ambient `src/sql.d.ts` declaration:

```ts
import definition from "./definition.sql" with { type: "text" };
```

Both the library build and CLI compilation explicitly configure `.sql` as text.
This matters on Bun 1.4.4: text attributes on a re-export alone can otherwise
produce a filesystem asset path instead of an embedded string. Do not introduce
runtime file loading. Persisted index definitions are authored in
`packages/core/src/db/sql/`, one execution unit per file. The explicit manifest
in `db/definitions.ts` preserves dependency order and per-statement SQL spans.
TypeScript still owns validation, preflight, transactions, locks, timeouts,
parameterized runtime queries, and the final bound schema-version insert.

`db/template.ts` uses Memory Engine-style `{{name}}` placeholders with a closed
vocabulary and prepared identifier/literal/numeric fragments. Literal fragments
include their quotes; do not add another pair in SQL. Numeric fragments come
from validated config, and the text configuration literal comes from
`pg_catalog.quote_literal`. Substitution is single-pass; unknown/malformed or
missing tokens fail. No includes, loops, expressions or signature directives.
The allowed names and their constructors live together in `template.ts`.

Format 2 is still immutable: extraction does not make these files migrations.
There is no ledger, replacement-function helper, or upgrade API. Function-body
indentation intentionally matches the old definitions exactly. Do not reformat
bodies or update catalog goldens just to make an equivalence test pass. The
pre-extraction fixtures, provenance and capture instructions are under
`packages/core/test/fixtures/schema-format-2/`. Their integration tests compare
both vector types with default/custom index settings, and retain exact function
bodies/settings/signatures plus tables, indexes, constraints, triggers, sequences
and object inventory. Capture runs only as an explicit maintenance action
against committed old DDL, never automatically during tests.

Node source tests preload `scripts/sql-loader.mjs`; it handles SQL imports only
and delegates other module loading to Node. The loader is development-only and
is exercised on Node 22.18+ and 24. Bun source tests use native text imports.

```sh
./bun run --filter searchgres build
./bun test scripts/build-core.test.ts
./bun scripts/with-postgres.ts ./bun run test:package
# Or, against an explicitly configured disposable database:
TEST_DATABASE_URL=postgresql://... ./bun run test:package
```

`test:package` packs the actual core, installs it with npm in an isolated temporary
consumer, typechecks consumer expressions (including `stripInternal` guards),
and exercises create/open/write/search/drop for both vector types on Node and
Bun. It also builds a compiled consumer using direct SQL imports, deletes the
consumer's source/package files, and runs the binary. The SQL probe is a separate
test module, never a public export or part of the package. Installed declarations
use the workspace's `skipLibCheck: true`: current AI SDK dependency declarations
fail their own `exactOptionalPropertyTypes` checks with it disabled. Consumer
expressions still use strict checking. npm installation requires registry access.

`test:package` runs at the end of `test:db`/`check:full` and in the Node 22/24
artifact CI matrix; `test:unit` covers SQL fidelity, external dependencies,
declarations/maps, stale output, and failed-build cleanup without a database.
It does not add a migration API or change schema format 2.

## Filter DSL

```sh
./bun run generate:filter-grammar
./bun run check:filter-grammar
```

The ISO/IEC 14977 grammar is
`packages/cli/src/filter/grammar/filter.ebnf`; the generated public railroad
reference remains `docs/reference/filter-syntax.html`. Executable conformance
cases are `packages/cli/src/filter/test/cases.yaml`. The parser emits core-shaped
filters; there is no protocol AST package. `ebnf2railroad` and fixture `yaml`
loading are development-only. Keep programmatic limits/diagnostics tests in
TypeScript.

## Building and distributing the binary

```sh
./bun run compile
./dist/searchgres --help
./dist/searchgres mcp --help
./bun run compile:all
```

Only `searchgres` ships. `compile:all` produces Linux/Windows/macOS amd64/arm64
assets and sibling SHA-256 files in root `dist/`. Root compile commands clear
stale artifacts. The installer downloads/verifies one matching executable.

Bun's compiled graph previously measured approximately 68 ms startup versus
20 ms for the removed client-only CLI; lazy imports did not eliminate compiled
module initialization. One binary is an intentional simplification, not a
license for unbounded startup work. Provider, tokenizer, MCP, and prompt code
remain; tokenizer threads are created only on first use. Measure the actual
binary with `./bun run bench:startup` (30 warm-cache samples after three warmups
for `--version`, `--help`, and unknown-option validation). Review material
regressions rather than comparing results across different machines as a gate.

Initial direct-binary baseline on the development macOS arm64 host (30 samples):
`--version` median 77.0 ms / p95 79.3 ms; `--help` median 78.1 ms / p95 85.1 ms;
unknown option median 77.1 ms / p95 78.2 ms. These are warm-cache process-start
measurements, not database/provider latency or a cross-platform performance
promise. The larger single graph has a measurable cost; keep monitoring it.

On macOS, compile commands replace Bun's signature with an ad-hoc signature and
`scripts/macos-entitlements.plist` for JIT support. All-target macOS builds are
signed when built on macOS; the installer retains signing as a fallback for
assets built elsewhere. To inspect:

```sh
codesign --verify --strict dist/searchgres
codesign -d --entitlements :- dist/searchgres
```

`packages/cli/scripts/bundle-tokenizer-worker.ts` generates ignored
`packages/cli/src/tokenizer/tokenizer.worker.generated.cjs`. The binary imports
it as embedded text and launches workers via `node:worker_threads` with `eval`.
Tokenizer model assets are bundled; no Hugging Face network request is needed.
Never manually edit or commit the generated worker, `dist/`, `.env`, or secrets.

## Local configuration and MCP

```sh
./dist/searchgres config
./dist/searchgres init --config searchgres.yaml
./dist/searchgres embeddings worker --config searchgres.yaml
./dist/searchgres mcp --config searchgres.yaml
```

The wizard is offline. `init --if-not-exists` strictly validates existing index
shape, not just schema existence. Ordinary commands never auto-provision.
See the [CLI guide](docs/guides/cli.md) for all commands and defaults and the
[MCP guide](docs/mcp/index.md) for host configuration.

Config lookup is explicit `--config`, `SEARCHGRES_CONFIG`, then
`./searchgres.yaml`. `.env` next to the config loads without replacing process
environment values; `--env-file` and `--no-env-file` override that behavior.
Generated secret files use owner-only permissions and exclusive creation.

The small dotenv reader/writer is owned here because there is no shared writer
across dotenv and deployment dialects. Generated values reject line breaks,
`#`, and leading/trailing whitespace instead of silently changing credentials.
Percent-encode URL passwords (`%23` for `#`). Existing dotenv tests preserve
round-trip behavior. Config files name secret environment variables, not literal
connection strings or API keys.

## Compose evaluation

```sh
docker compose up -d --build
docker compose wait model init
./dist/searchgres --config docker/evaluation/searchgres.yaml \
  --env-file docker/evaluation/.env.sample info
./bun run check:compose
./bun run test:compose
```

Services are `db`, `ollama`, `model`, `init`, and `worker`. DB/Ollama ports are
loopback-bound for host CLI access; semantic queries themselves require the
provider. Init/worker use the same read-only config with container-specific
environment values. See the [evaluation guide](docs/guides/docker-compose.md).

Cheap topology tests run with unit tests. CI builds `docker/Dockerfile.cli`
from the clean `.dockerignore` context. The optional real-model smoke owns a
unique project, ephemeral ports, and disposable volumes; it verifies direct
CLI retrieval, worker processing, and preserved-state restart. Run the manual
Compose workflow before releases and after stack/model changes.

## Publishing the core package

Core remains the unscoped npm package `searchgres`. A stable `vX.Y.Z` tag starts
`.github/workflows/release.yml`. Its commit must be on `main` and its version
must match `packages/core/package.json`. Release checks build/pack core, install
it into a scratch npm consumer, verify its public entry point/legal files, and
publish with provenance. CI tests the packed core under Node 22/24 and Bun.

Before tagging:

1. Match versions in `packages/core/package.json` and `packages/core/src/version.ts`.
2. Update `CHANGELOG.md` and set the pinned binary-installation example in
   `docs/installation.md` to the release tag. It must name a release containing
   the direct CLI assets, not an old server-era tag.
3. Run `./bun run check:full`, review startup measurements and Compose gates,
   commit and merge to `main`.
4. Tag that commit and push the immutable tag.

Never move/reuse a published tag. A rerun skips an already-published npm version.
For first publication, configure a short-lived granular `NPM_TOKEN` Actions
secret. Afterward configure npm trusted publishing for `timescale/searchgres-js`,
workflow `release.yml`, no environment; remove/revoke the bootstrap token.
Later releases use GitHub OIDC credentials and npm provenance. Coordinate any
repository or workflow rename with npm's trusted-publisher setting.

After core publication succeeds, the release workflow builds the one binary on
macOS, signs both macOS targets, and attaches all platform executables and their
checksums to the tagged GitHub release. The binary reports core's library
version; it does not have an independently versioned product API. After the
assets are published, verify both latest-release and pinned-tag installation
into a temporary directory, then run the installed binary's `--version` and
`mcp --help`.
