# Install searchgres.js

searchgres.js is published on npm as `searchgres`. The primary distribution is
the runtime-agnostic TypeScript library. Install it
with `postgres.js` and the AI SDK provider of your choice:

```bash
npm install searchgres postgres @ai-sdk/openai
```

`searchgres` is compiled ESM with type declarations. It has no native addon,
postinstall script, provider credentials, or Bun-only runtime dependency.

The [`postgres`](https://github.com/porsager/postgres) package is the database
driver. searchgres.js uses the provider-agnostic [`ai`](https://ai-sdk.dev) package
but no provider package; replace `@ai-sdk/openai` with Mistral, Google, another
AI SDK provider, or your own compatible embedding model.

Next, ensure your PostgreSQL environment meets the requirements below, then
follow [Get started](getting-started.md).

## Runtime support

- Node 22 or newer
- Bun 1.4 or newer

Published consumers use compiled JavaScript. Running the repository's `.ts`
examples directly with Node requires Node 22.18 or newer.

## PostgreSQL

searchgres.js targets **PostgreSQL 18** and requires three extensions:

| Extension | Provides | Minimum version |
| --- | --- | --- |
| [`pgvector`](https://github.com/pgvector/pgvector) | `vector` / `halfvec` columns and HNSW cosine indexes | 0.8.0 |
| [`pg_textsearch`](https://github.com/timescale/pg_textsearch) | BM25 index and ranking | 1.4.0 |
| `ltree` | Hierarchical tree paths (ships with PostgreSQL) | 1.3.0 |

Two requirements are worth calling out up front:

- **`pg_textsearch` must be preloaded.** It uses a shared library configured
  before the server starts:

  ```conf
  shared_preload_libraries = 'pg_textsearch'
  ```

- **The extensions must live in `public`.** `createIndex()` installs a missing
  extension into `public`; if one already exists in another schema it throws an
  [`ExtensionError`](reference/errors.md) rather than moving it.

### Privileges

The role used with `createIndex()` needs to:

- run `CREATE EXTENSION` the first time an extension is missing;
- create schemas and objects.

If extension creation is restricted, install all three in `public` with a
privileged role first. The application role then only needs the privileges
required to create and use its index schema.

## Production PostgreSQL with Tiger Cloud

[Tiger Cloud](https://www.tigerdata.com/cloud) is a turnkey managed PostgreSQL
option for production searchgres.js workloads. PostgreSQL 18 and all three required
extensions—`pgvector`, `pg_textsearch`, and `ltree`—are available on the
platform, so you do not need to build or operate a custom database image.

Create a Tiger Cloud service, copy its PostgreSQL connection string into your
application's `DATABASE_URL`, and use it with `postgres.js` normally:

```ts
const sql = postgres(process.env.DATABASE_URL, { ssl: "require" });
```

Then call `createIndex()` with a role allowed to install the available
extensions and create schemas, or pre-install the extensions in `public` with an
administrative role before provisioning the index. Your application continues
to own its pool, index names, embedding provider, and worker deployment.

For production concerns beyond database provisioning, see
[Run in production](guides/production.md).

## Database-only setup with Docker

The repository includes a Dockerfile that builds PostgreSQL 18 with all three
extensions and the required preload configuration. Use it when you want to run
the core library against a local database while managing the application and
embedding provider yourself.

```bash
git clone https://github.com/timescale/searchgres-js.git
cd searchgres-js

docker build -t searchgres-postgres -f docker/Dockerfile.postgres docker/

docker run -d --name searchgres-postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -p 127.0.0.1:5432:5432 \
  searchgres-postgres
```

Trust authentication is for local development only.

Verify extension availability:

```bash
psql postgres://postgres@127.0.0.1:5432/postgres -c \
  "select name, default_version from pg_available_extensions
   where name in ('vector','pg_textsearch','ltree') order by name;"
```

## You own the connection pool

searchgres.js never creates, closes, or persistently reconfigures a connection.
Create the pool, pass it to `createIndex()` and `openIndex()`, and close it when
your application shuts down:

```ts
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL, { max: 10 });

try {
  // Use sql with searchgres.js.
} finally {
  await sql.end();
}
```

Separate pools can point at different databases, and several index handles can
share one pool. See [Create and manage indexes](guides/indexes.md).

## Try without writing an application

For a no-API-key evaluation, run the optional Compose stack:

```bash
git clone https://github.com/timescale/searchgres-js.git
cd searchgres-js
docker compose up --build
```

It includes PostgreSQL, Ollama, automatic model download, strict index
provisioning, and an embedding worker. This is an alternate evaluation path, not a
requirement for the core library. See
[Evaluate with Docker Compose](guides/docker-compose.md) for sample commands,
performance expectations, persistence, and its evaluation-only security
boundary.

## Reference binary

Releases include one compiled `searchgres` executable for direct PostgreSQL CLI
operations, embedding workers, and `searchgres mcp`. Install it with:

```bash
curl -fsSL https://raw.githubusercontent.com/timescale/searchgres-js/main/install.sh | sh
```

The installer detects Linux or macOS on amd64/arm64 (and Windows under a POSIX
shell), downloads matching GitHub release assets, and verifies individual
SHA-256 files before installing. The default destination is `~/.local/bin` when
`~/.local` exists, otherwise `~/bin`.

Override the destination or release tag on the receiving shell:

```bash
curl -fsSL https://raw.githubusercontent.com/timescale/searchgres-js/main/install.sh | \
  SEARCHGRES_INSTALL_DIR="$HOME/.local/bin" SEARCHGRES_VERSION=v0.3.2 sh
```

This binary is a maintained reference and evaluation tool over the same core,
not a required layer or co-equal product. See
[Reference implementations and evaluation tools](reference-applications.md) and
the [CLI guide](guides/cli.md) for configuration and security boundaries. It
holds database/provider credentials locally; no searchgres.js network service is
required.

Next: [Get started](getting-started.md).
