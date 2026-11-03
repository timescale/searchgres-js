// Deliberate maintenance command, never run by tests. Node-compatible so this
// harness can capture the embedded-DDL implementation from an older checkout.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import postgres from "postgres";
import type { createIndex as CreateIndex } from "../packages/core/src/create-index.ts";
import {
  dropTestSchema,
  randomTestSchema,
} from "../packages/core/test/support/db.ts";
import {
  catalogEnvironment,
  SCHEMA_FORMAT_CASES,
  schemaCatalog,
} from "../packages/core/test/support/schema-catalog.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "source-root": { type: "string" },
    "confirm-pre-extraction": { type: "boolean", default: false },
  },
});
assert.ok(
  values.output && values["confirm-pre-extraction"],
  "usage: capture-schema-baseline.ts --output <directory> --confirm-pre-extraction [--source-root <old-checkout>]",
);
assert.ok(
  process.env.TEST_DATABASE_URL,
  "TEST_DATABASE_URL is required; run through ./bun scripts/with-postgres.ts",
);
const sourceRoot = resolve(
  values["source-root"] ?? fileURLToPath(new URL("..", import.meta.url)),
);
const output = resolve(values.output);
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trimEnd();
const ddlPaths = [
  "packages/core/src/create-index.ts",
  ...(
    await readdir(resolve(sourceRoot, "packages/core/src/db/routines")).catch(
      (cause: unknown) => {
        throw new Error(
          "Original TypeScript builders not found; use --source-root <pre-extraction-checkout>",
          { cause },
        );
      },
    )
  )
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => `packages/core/src/db/routines/${name}`),
];
assert.equal(
  git("diff", "HEAD", "--", ...ddlPaths),
  "",
  "capture requires committed, unmodified pre-extraction DDL",
);
const ddlSources = [];
for (const path of ddlPaths) {
  const source = await readFile(resolve(sourceRoot, path));
  ddlSources.push({
    path,
    sha256: createHash("sha256").update(source).digest("hex"),
  });
}
const { createIndex } = (await import(
  pathToFileURL(resolve(sourceRoot, "packages/core/src/create-index.ts")).href
)) as { createIndex: typeof CreateIndex };
const sql = postgres(process.env.TEST_DATABASE_URL, {
  max: 1,
  onnotice: () => {},
});
try {
  const snapshots = [];
  for (const { name, config } of SCHEMA_FORMAT_CASES) {
    const schema = randomTestSchema();
    try {
      await createIndex(sql, schema, config);
      snapshots.push({
        name,
        config,
        catalog: await schemaCatalog(sql, schema),
      });
    } finally {
      await dropTestSchema(sql, schema);
    }
  }
  const provenance = {
    description:
      "PRE-EXTRACTION format-2 catalog, captured by executing the original embedded TypeScript DDL (not extracted SQL). DDL source files match HEAD; unrelated working-tree changes are recorded below.",
    gitHead: git("rev-parse", "HEAD"),
    workingTreeStatus: git("status", "--short"),
    ddlSources,
    environment: await catalogEnvironment(sql),
  };
  await mkdir(output, { recursive: true });
  // Exclusive writes: even this explicit command cannot silently replace a
  // golden. Capture into a new directory, then review changes deliberately.
  for (const { name, config, catalog } of snapshots) {
    await writeFile(
      resolve(output, `${name}.json`),
      `${JSON.stringify({ config, catalog }, null, 2)}\n`,
      { flag: "wx" },
    );
  }
  await writeFile(
    resolve(output, "provenance.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: "wx" },
  );
  console.log(`Captured ${snapshots.length} format-2 catalogs in ${output}`);
} finally {
  await sql.end();
}
