import { expect, test } from "bun:test";
import { InvalidInputError } from "searchgres";
import { z } from "zod";
import {
  filterFlagNames,
  flagNameFor,
  paramsFromFlags,
  searchOptionFlags,
  withSearchFlagNames,
} from "./cli.ts";
import { searchParamsSchema } from "./inputs.ts";

/** Build the flag map Commander would hand `paramsFromFlags`. */
function flags(...pairs: readonly [string, string | true][]) {
  return new Map<string, string | true>(pairs);
}

function search(...pairs: readonly [string, string | true][]) {
  return paramsFromFlags("search", flags(...pairs));
}

test("every filter leaf has a flag, and each maps to its own filter key", () => {
  // The flag list is derived from the leaf table, so this pins the table
  // against the protocol's filter schema: a leaf added there without a flag
  // (or a flag whose name drifts from its key) fails here.
  expect([...filterFlagNames]).toEqual([
    "tree",
    "lquery",
    "ltxtquery",
    "meta",
    "meta-predicate",
    "temporal-within",
    "temporal-overlaps",
    "temporal-before",
    "temporal-after",
    "temporal-contains",
    "regexp",
  ]);

  // Each flag alone produces a bare leaf keyed by its camelCase name. A wiring
  // mistake — two flags sharing a key, or a flag pointing at the wrong one —
  // shows up as a mismatched key here rather than as a silently wrong query.
  const scalar: Record<string, string> = {
    tree: "docs.auth",
    lquery: "docs.*",
    ltxtquery: "auth & token",
    "meta-predicate": "$.size > 50",
    "temporal-before": "2024-04-01T00:00:00Z",
    "temporal-after": "2024-04-01T00:00:00Z",
    "temporal-contains": "2024-03-01T12:00:00Z",
    regexp: "^abc",
  };
  for (const [flag, value] of Object.entries(scalar)) {
    expect(search([flag, value]), flag).toEqual({
      filter: { [camelCase(flag)]: value },
    });
  }
});

test("meta parses a JSON object; ranges parse into a start/end pair", () => {
  expect(search(["meta", '{"colour":"red","size":10}'])).toEqual({
    filter: { meta: { colour: "red", size: 10 } },
  });
  for (const flag of ["temporal-within", "temporal-overlaps"]) {
    expect(
      search([flag, "2024-01-01T00:00:00Z,2024-02-01T00:00:00Z"]),
      flag,
    ).toEqual({
      filter: {
        [camelCase(flag)]: ["2024-01-01T00:00:00Z", "2024-02-01T00:00:00Z"],
      },
    });
  }
  // Split on the first comma only: an ISO-8601 instant contains none, and a
  // trailing comma is a missing bound rather than an empty one.
  expect(() => search(["temporal-within", "2024-01-01T00:00:00Z"])).toThrow(
    /"start,end" range/,
  );
  expect(() => search(["temporal-within", "2024-01-01T00:00:00Z,"])).toThrow(
    /"start,end" range/,
  );
});

test("several filter flags are ANDed; a single leaf is not wrapped", () => {
  // The filter schema rejects a one-element `and`, so one leaf must pass
  // through bare.
  expect(search(["tree", "docs"])).toEqual({ filter: { tree: "docs" } });
  expect(
    search(["tree", "docs"], ["regexp", "abc"], ["meta-predicate", "$.n > 1"]),
  ).toEqual({
    filter: {
      and: [{ tree: "docs" }, { metaPredicate: "$.n > 1" }, { regexp: "abc" }],
    },
  });
});

test("--k maps to the RRF constant and must be a non-negative number", () => {
  expect(
    search(["semantic", "cats"], ["fulltext", "cat"], ["k", "40"]),
  ).toEqual({ semantic: "cats", fulltext: "cat", k: 40 });
  expect(search(["semantic", "a"], ["fulltext", "b"], ["k", "0"])).toEqual({
    semantic: "a",
    fulltext: "b",
    k: 0,
  });
  for (const bad of ["-1", "", "abc", "Infinity"]) {
    expect(() =>
      search(["semantic", "a"], ["fulltext", "b"], ["k", bad]),
    ).toThrow("--k must be a non-negative number");
  }
});

test("ranking arms and filters combine, and knobs are typed", () => {
  expect(search(["semantic", "cats"], ["fulltext", "cat"])).toEqual({
    semantic: "cats",
    fulltext: "cat",
  });
  expect(
    search(
      ["semantic", "cats"],
      ["tree", "docs"],
      ["limit", "5"],
      ["candidate-limit", "50"],
      ["semantic-threshold", "0.25"],
      ["semantic-weight", "0.7"],
      ["fulltext-weight", "0.3"],
    ),
  ).toEqual({
    semantic: "cats",
    filter: { tree: "docs" },
    limit: 5,
    candidateLimit: 50,
    semanticThreshold: 0.25,
    semanticWeight: 0.7,
    fulltextWeight: 0.3,
  });
  expect(
    search(
      ["tree", "docs"],
      ["order", "asc"],
      ["after", "01900000-0000-7000-8000-000000000000"],
    ),
  ).toEqual({
    filter: { tree: "docs" },
    order: "asc",
    after: "01900000-0000-7000-8000-000000000000",
  });
});

test("invalid flag values are rejected before a request is made", () => {
  const cases: readonly (readonly [readonly [string, string][], RegExp])[] = [
    [[["meta", "not-json"]], /--meta must be valid JSON/],
    [[["meta", '["array"]']], /--meta must be a JSON object/],
    [[["meta", '"text"']], /--meta must be a JSON object/],
    [
      [
        ["tree", "docs"],
        ["order", "sideways"],
      ],
      /--order must be one of/,
    ],
    [
      [
        ["tree", "docs"],
        ["limit", "0"],
      ],
      /--limit must be a positive integer/,
    ],
    [
      [
        ["tree", "docs"],
        ["limit", "1.5"],
      ],
      /--limit must be a positive integer/,
    ],
    [
      [
        ["semantic", "x"],
        ["semantic-threshold", "7"],
      ],
      /--semantic-threshold must be a number between 0 and 1/,
    ],
    [
      [
        ["semantic", "x"],
        ["semantic-weight", "-1"],
      ],
      /--semantic-weight must be a number between 0 and 1/,
    ],
  ];
  for (const [pairs, pattern] of cases) {
    expect(() => search(...pairs), JSON.stringify(pairs)).toThrow(pattern);
  }
  // No ranking arm and no filter is not a search.
  expect(() => search()).toThrow(/requires a ranking flag/);
});

test("presentation selection is never included in search RPC params", () => {
  expect(search(["tree", "docs"], ["select", "id,content:200"])).toEqual({
    filter: { tree: "docs" },
  });
});

test("search validation errors name flags, not library fields", () => {
  // These messages follow core's search option validation text.
  const core = new InvalidInputError(
    "Invalid search options: candidateLimit: candidateLimit only applies to a hybrid search (both semantic and fulltext)",
    {
      issues: [
        {
          code: "custom",
          path: ["candidateLimit"],
          message:
            "candidateLimit only applies to a hybrid search (both semantic and fulltext)",
        },
        {
          code: "custom",
          path: ["semanticThreshold"],
          message: "semanticThreshold requires a `semantic` or `vector` arm",
        },
        {
          code: "custom",
          path: ["order"],
          message: "order only applies to a filter-only search",
        },
        {
          code: "custom",
          path: ["before"],
          message: "provide either `after` or `before`, not both",
        },
        { code: "custom", path: ["k"], message: "k only applies to hybrid" },
        {
          code: "custom",
          path: ["filter", "and", 0],
          message: "unchanged filter issue",
        },
      ],
    },
  );
  const rewritten = withSearchFlagNames(core);
  expect(rewritten).toBeInstanceOf(InvalidInputError);
  const error = rewritten as InvalidInputError;
  expect(error.message).toBe(
    "Invalid search options: --candidate-limit: --candidate-limit only applies to a hybrid search (both semantic and fulltext)",
  );
  expect(error.issues).toEqual([
    {
      code: "custom",
      path: ["--candidate-limit"],
      message:
        "--candidate-limit only applies to a hybrid search (both semantic and fulltext)",
    },
    {
      code: "custom",
      path: ["--semantic-threshold"],
      message: "--semantic-threshold requires a `--semantic` or `vector` arm",
    },
    {
      code: "custom",
      path: ["--order"],
      message: "--order only applies to a filter-only search",
    },
    {
      code: "custom",
      path: ["--before"],
      message: "provide either `--after` or `--before`, not both",
    },
    { code: "custom", path: ["--k"], message: "--k only applies to hybrid" },
    {
      code: "custom",
      path: ["filter", "and", 0],
      message: "unchanged filter issue",
    },
  ]);
  // The original core error stays unchanged.
  expect(core.issues[0]?.path).toEqual(["candidateLimit"]);

  // The CLI's own schema reports flag paths too.
  const parsed = searchParamsSchema.safeParse({ fulltext: "x", limit: 5000 });
  expect(parsed.success).toBe(false);
  const zodError = withSearchFlagNames(parsed.error) as z.ZodError;
  expect(zodError).toBeInstanceOf(z.ZodError);
  expect(zodError.issues.map((issue) => issue.path)).toEqual([["--limit"]]);

  const other = new Error("other");
  expect(withSearchFlagNames(other)).toBe(other);
});

test("flag names derive from leaf keys", () => {
  expect(flagNameFor("temporalWithin")).toBe("temporal-within");
  expect(flagNameFor("tree")).toBe("tree");
});

function camelCase(flag: string): string {
  return flag.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

test("every search parameter with a flag has a flag-name mapping", () => {
  // `filter` comes from several flags.
  const withoutFlag = new Set(["filter"]);
  expect(
    Object.keys(searchParamsSchema.shape)
      .filter((key) => !withoutFlag.has(key))
      .sort(),
  ).toEqual(Object.keys(searchOptionFlags).sort());
});
