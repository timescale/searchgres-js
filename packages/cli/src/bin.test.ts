import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { InvalidInputError } from "searchgres";
import { formatError, InputError } from "./runtime/report.ts";

const entry = resolve(import.meta.dir, "bin.ts");

async function run(args: readonly string[]) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SEARCHGRES_CONFIG: "/nonexistent/searchgres.yaml" },
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, out, err };
}

test("Commander parse errors use the JSON error envelope and exit 2", async () => {
  const unknown = await run(["search", "--limt", "3"]);
  expect(unknown.code).toBe(2);
  expect(unknown.out).toBe("");
  expect(unknown.err).toBe(
    `${JSON.stringify({
      error: {
        code: "INVALID_INPUT",
        message: "unknown option '--limt'\n(Did you mean --limit?)",
      },
    })}\n`,
  );

  const conflict = await run(["search", "--filter", "(tree a)", "--tree", "a"]);
  expect(conflict.code).toBe(2);
  expect(JSON.parse(conflict.err)).toEqual({
    error: {
      code: "INVALID_INPUT",
      message:
        "option '--filter <expression>' cannot be used with option '--tree <path>'",
    },
  });
});

test("help and version stay on stdout with exit 0", async () => {
  const help = await run(["search", "--help"]);
  expect(help.code).toBe(0);
  expect(help.err).toBe("");
  expect(help.out).toContain("Usage: searchgres search");
  const version = await run(["--version"]);
  expect(version.code).toBe(0);
  expect(version.err).toBe("");
  expect(version.out.trim()).toMatch(/^\d+\.\d+\.\d+/);
});

test("terminal error output is readable text; other output is one JSON line", () => {
  const error = new InvalidInputError(
    "--filter:1:20: expected `)` to close `tree`\n(tree docs\n          ^",
    {
      issues: [
        { code: "custom", path: ["--limit"], message: "too big" },
        { code: "custom", path: [], message: "no path" },
      ],
    },
  );
  expect(formatError(error, true)).toBe(
    [
      "error [INVALID_INPUT]: --filter:1:20: expected `)` to close `tree`",
      "(tree docs",
      "          ^",
      "  - --limit: too big",
      "  - no path",
    ].join("\n"),
  );
  expect(formatError(error, false)).toBe(
    JSON.stringify({
      error: {
        code: "INVALID_INPUT",
        message: error.message,
        issues: [
          { code: "custom", path: ["--limit"], message: "too big" },
          { code: "custom", path: [], message: "no path" },
        ],
      },
    }),
  );
  expect(formatError(new InputError("bad"), true)).toBe(
    "error [INVALID_INPUT]: bad",
  );
});
