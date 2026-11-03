import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCore } from "./build-core.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixture = join(root, "packages/core/src/test/fixtures/text.sql");

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "searchgres-build-"));
  await mkdir(join(directory, "src"));
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "junction",
  );
  await writeFile(join(directory, "package.json"), '{"type":"module"}');
  await writeFile(
    join(directory, "tsconfig.build.json"),
    JSON.stringify({
      extends: join(root, "tsconfig.base.json"),
      compilerOptions: {
        rootDir: "src",
        outDir: "dist",
        declaration: true,
        emitDeclarationOnly: true,
        stripInternal: true,
        types: ["node"],
      },
      include: ["src/**/*.ts"],
    }),
  );
  await copyFile(fixture, join(directory, "src/text.sql"));
  await copyFile(
    join(root, "packages/core/src/sql.d.ts"),
    join(directory, "src/sql.d.ts"),
  );
  await writeFile(
    join(directory, "src/index.ts"),
    `import text from "./text.sql" with { type: "text" };
import { z } from "zod";
/** @internal */
export { default as reexportedSql } from "./text.sql" with { type: "text" };
/** @internal */
export const internalOnly = true;
export function definition(name: string): string {
  z.string().min(1).parse(name);
  return text;
}
`,
  );
  return directory;
}

async function checkNode(directory: string) {
  const hash = createHash("sha256")
    .update(await readFile(join(directory, "src/text.sql")))
    .digest("hex");
  const code = `import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { definition, reexportedSql } from "./dist/index.js";
assert.equal(reexportedSql, definition("test"));
assert.equal(createHash("sha256").update(definition("test")).digest("hex"), ${JSON.stringify(hash)});
assert.throws(() => definition(""), (error) => {
  assert.ok(error.stack.includes("src/index.ts"), error.stack);
  return true;
});`;
  const child = Bun.spawn(
    ["node", "--enable-source-maps", "--input-type=module", "-e", code],
    {
      cwd: directory,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  expect(await child.exited).toBe(0);
}

test("core build embeds SQL, retains declarations/maps and external dependencies, and clears stale output", async () => {
  const directory = await project();
  try {
    await buildCore(directory);
    const output = await readFile(join(directory, "dist/index.js"), "utf8");
    expect(output).toContain('from "zod"');
    expect(output).not.toContain('with { type: "text" }');
    const types = await readFile(join(directory, "dist/index.d.ts"), "utf8");
    expect(types).toContain("definition(name: string): string");
    expect(types).not.toContain("internalOnly");
    expect(types).not.toContain(".sql");
    const map = JSON.parse(
      await readFile(join(directory, "dist/index.js.map"), "utf8"),
    );
    expect(
      map.sourcesContent.some((source: string) =>
        source.includes("function definition"),
      ),
    ).toBe(true);
    await checkNode(directory);
    await buildCore(directory);
    expect(await readFile(join(directory, "dist/index.js"), "utf8")).toBe(
      output,
    );
    await writeFile(join(directory, "dist/stale.js"), "stale");
    await writeFile(join(directory, "src/text.sql"), "select 'updated';\n");
    await buildCore(directory);
    expect(await Bun.file(join(directory, "dist/stale.js")).exists()).toBe(
      false,
    );
    await checkNode(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a failed declaration build removes all output", async () => {
  const directory = await project();
  try {
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "dist/stale.js"), "stale");
    await writeFile(
      join(directory, "src/index.ts"),
      "const invalid: number = 'not a number';\n",
    );
    await expect(buildCore(directory)).rejects.toThrow(
      "Core declaration build failed",
    );
    expect(await Bun.file(join(directory, "dist/stale.js")).exists()).toBe(
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("a failed SQL bundle removes declaration output too", async () => {
  const directory = await project();
  try {
    await rm(join(directory, "src/text.sql"));
    // Bun can reject the build promise before returning a result/log envelope.
    await expect(buildCore(directory)).rejects.toThrow();
    expect(await Bun.file(join(directory, "dist/index.d.ts")).exists()).toBe(
      false,
    );
    expect(await Bun.file(join(directory, "dist/index.js")).exists()).toBe(
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test("the Bun wrapper and Docker build pin the same version", async () => {
  const wrapper = await readFile(join(root, "bun"), "utf8");
  const docker = await readFile(join(root, "docker/Dockerfile.cli"), "utf8");
  const version = /version="bun-v([\d.]+)"/.exec(wrapper)?.[1];
  expect(version).toBeDefined();
  expect(docker).toContain(`FROM oven/bun:${version} AS build`);
});
