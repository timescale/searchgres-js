// Real npm-consumer and compiled-artifact qualification. Run with a disposable
// TEST_DATABASE_URL (normally through with-postgres.ts), never a production DB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as source from "../packages/core/src/index.ts";
import { buildCore } from "./build-core.ts";

assert.ok(process.env.TEST_DATABASE_URL, "TEST_DATABASE_URL is required");
const root = fileURLToPath(new URL("../", import.meta.url));
const bun = join(root, "bun");
const temporary = await mkdtemp(join(tmpdir(), "searchgres-package-"));
const consumer = join(temporary, "consumer");
const core = join(root, "packages/core");
const expectedExports = JSON.stringify(Object.keys(source).sort());
const sqlBytes = await readFile(join(core, "src/test/fixtures/text.sql"));
const env = {
  ...process.env,
  SQL_PROBE_HASH: createHash("sha256").update(sqlBytes).digest("hex"),
  EXPECTED_EXPORTS: expectedExports,
};

async function run(command: string[], cwd = consumer) {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) {
    throw new Error(
      `Package qualification failed: ${command[0]} ${command[1]}`,
    );
  }
}

try {
  await buildCore();
  await mkdir(consumer);
  await run(
    [bun, "pm", "pack", "--cwd", core, "--destination", temporary],
    root,
  );
  const tarballs = (await readdir(temporary)).filter((file) =>
    file.endsWith(".tgz"),
  );
  assert.equal(tarballs.length, 1);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  await run([
    "npm",
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    join(temporary, tarballs[0] ?? ""),
    "@types/node@^22",
    "@types/json-schema",
  ]);
  const installed = join(consumer, "node_modules/searchgres");
  for (const file of [
    "README.md",
    "LICENSE",
    "NOTICE",
    "dist/index.js",
    "dist/index.d.ts",
  ]) {
    assert.ok((await readFile(join(installed, file))).length > 0, file);
  }
  const shipped = await readdir(installed, { recursive: true });
  assert.ok(!shipped.includes("src"));
  assert.ok(
    !shipped.some((file) => file.endsWith(".sql") || file.includes(".test.")),
  );
  const declaration = await readFile(
    join(installed, "dist/open-index.d.ts"),
    "utf8",
  );
  assert.ok(
    !declaration.includes("readonly sql:"),
    "stripInternal must hide Index.sql",
  );

  await copyFile(
    join(root, "scripts/fixtures/packaged-consumer.mjs"),
    join(consumer, "consumer.mjs"),
  );
  await copyFile(
    join(root, "scripts/fixtures/packaged-consumer.ts"),
    join(consumer, "consumer.ts"),
  );
  await writeFile(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noUncheckedIndexedAccess: true,
        exactOptionalPropertyTypes: true,
        // Match the workspace: current AI SDK declarations fail their own
        // exactOptionalPropertyTypes checks. Consumer expressions still use
        // strict checking, including the @ts-expect-error declaration guards.
        skipLibCheck: true,
        noEmit: true,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }),
  );
  await run(
    [bun, "x", "--no-install", "tsc", "-p", join(consumer, "tsconfig.json")],
    root,
  );

  // Use the same Bun text loader as the production build, with real SQL bytes.
  // Keep this probe out of the published package and remove its sources before
  // any consumer runs. It supplements the real embedded product definitions
  // with arbitrary quoting/Unicode/line-ending edge cases.
  const probeSource = join(temporary, "probe-source");
  await mkdir(probeSource);
  await writeFile(join(probeSource, "text.sql"), sqlBytes);
  await writeFile(
    join(probeSource, "sql-probe.ts"),
    'export { default as sqlText } from "./text.sql" with { type: "text" };\n',
  );
  const probe = await Bun.build({
    entrypoints: [join(probeSource, "sql-probe.ts")],
    outdir: consumer,
    target: "node",
    format: "esm",
    packages: "external",
    loader: { ".sql": "text" },
    sourcemap: "linked",
  });
  if (!probe.success)
    throw new AggregateError(probe.logs, "SQL probe build failed");
  await rm(probeSource, { recursive: true });
  await run(["node", "--enable-source-maps", "consumer.mjs"]);
  await run([bun, "consumer.mjs"]);

  // The compiled path must embed direct SQL imports too, not only already
  // embedded JavaScript. Use the same explicit loader as the actual CLI.
  await writeFile(join(consumer, "text.sql"), sqlBytes);
  await writeFile(
    join(consumer, "sql-probe.js"),
    'export { default as sqlText } from "./text.sql" with { type: "text" };\n',
  );
  // Bundle the installed package, not the workspace's source-path alias.
  const executable = join(
    temporary,
    process.platform === "win32" ? "consumer-bin.exe" : "consumer-bin",
  );
  await run([
    bun,
    "build",
    "./consumer.mjs",
    "--compile",
    "--loader=.sql:text",
    "--outfile",
    executable,
  ]);
  await run([bun, join(root, "scripts/macos-sign.ts"), executable], root);
  // A standalone binary must not use the installed package or probe file.
  await rm(consumer, { recursive: true });
  await run([executable], temporary);
  console.log(
    "Package qualification passed: declarations, Node, Bun, and compiled executable.",
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
