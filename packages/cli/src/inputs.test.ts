import { expect, test } from "bun:test";
import { filterSchema } from "./inputs.ts";

function firstIssue(filter: unknown) {
  const parsed = filterSchema.safeParse(filter);
  expect(parsed.success).toBe(false);
  return parsed.error?.issues[0];
}

test("filter schema issues name the problem for MCP and DSL callers", () => {
  expect(firstIssue({ page_title: "x" })?.message).toContain(
    'unknown filter key "page_title"',
  );
  expect(firstIssue({ tree: "a", meta: { b: 1 } })?.message).toContain(
    'exactly one key, but it has 2 ("tree", "meta")',
  );
  const nested = firstIssue({ and: [{ tree: "a" }, { not: { tree: 5 } }] });
  expect(nested?.path).toEqual([]);
  expect(nested?.message).toMatch(/^and\.1\.not\.tree: .*expected string/);
});

test("the filter issue helpers stay a copy of the core file", async () => {
  const header =
    "// This file is a copy of packages/core/src/filter-issues.ts. Keep the two\n// files the same. Core does not export it.\n";
  const cli = await Bun.file(
    new URL("./filter/issues.ts", import.meta.url),
  ).text();
  const core = await Bun.file(
    new URL("../../core/src/filter-issues.ts", import.meta.url),
  ).text();
  expect(cli).toBe(header + core);
});
