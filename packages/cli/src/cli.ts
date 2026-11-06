import type { Index, TreeCountSelector } from "searchgres";
import { exportRecords, importRecords } from "./bulk.ts";
import { duration, loadConfiguredCommand } from "./config/config.ts";
import { filterExpressionFromFlags } from "./filter-input.ts";
import {
  camelCase,
  enumeration,
  type Flags,
  flagsFromOptions,
  kebabCase,
  nonnegativeInteger,
  optionalFlag,
  parseJsonObject,
  positiveInteger,
  requiredFlag,
  unitInterval,
} from "./flags.ts";
import {
  hasExplicitOutputFormat,
  outputFormat,
  readStructuredFile,
  readStructuredInput,
  writeStructuredOutput,
} from "./format.ts";
import type { Filter } from "./inputs.ts";
import {
  patchInputSchema,
  recordInputSchema,
  searchParamsSchema,
} from "./inputs.ts";
import {
  parseSelectFields,
  presentRecord,
  projectSearchEnvelope,
} from "./presentation/index.ts";
import { installShutdown, openRuntime } from "./runtime/index.ts";
import { InputError } from "./runtime/report.ts";

export { flagsFromOptions };

const usage = `Usage:
  searchgres <command> [options]

Run \`searchgres --help\` for the command list.
`;

export async function runCommand(
  command: string,
  flags: Flags,
  args: readonly string[] = [],
): Promise<void> {
  assertOutputFormatApplies(command, flags);
  const { config } = await loadConfiguredCommand(flags);
  const runtime = await openRuntime(config);
  const shutdown = installShutdown(() => runtime.close());
  const client = runtime.index;
  try {
    await runtime.run(async () => {
      switch (command) {
        case "info":
          return output(await runtime.info(), flags);
        case "vector-index stats":
          return output(await client.vectorIndexStats(), flags);
        case "vector-index reindex": {
          const rawNlist = optionalFlag(flags, "nlist");
          const nlist =
            rawNlist === undefined
              ? undefined
              : rawNlist === "auto"
                ? ("auto" as const)
                : positiveInteger(rawNlist, "nlist");
          const parseDurationFlag = (flagName: string) => {
            const raw = optionalFlag(flags, flagName);
            if (raw === undefined) return undefined;
            try {
              return duration(raw);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              throw new InputError(`Invalid --${flagName}: ${message}`);
            }
          };
          const lockTimeoutMs = parseDurationFlag("lock-timeout");
          const statementTimeoutMs = parseDurationFlag("statement-timeout");
          return output(
            await client.reindexVectorIndex({
              concurrently: flags.has("concurrently"),
              ...(nlist === undefined ? {} : { nlist }),
              ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
              ...(statementTimeoutMs === undefined
                ? {}
                : { statementTimeoutMs }),
            }),
            flags,
          );
        }
        case "create":
          return runCreate(client, flags);
        case "get":
          return runGet(client, flags, args);
        case "update":
          return runUpdate(client, flags, args);
        case "delete":
          return runDelete(client, flags, args);
        case "search":
          return runSearch(client, flags);
        case "import":
          return runImport(client, flags, args);
        case "export":
          return runExport(client, flags, args);
        case "tree":
          return runTree(client, flags, args);
        case "count": {
          const params = paramsFromFlags("count", flags) as {
            selector: TreeCountSelector;
            limit?: number;
          };
          return output(
            await client.countTree(
              params.selector,
              params.limit === undefined ? {} : { limit: params.limit },
            ),
            flags,
          );
        }
        case "list":
          return output(
            { entries: await client.listTree(requiredFlag(flags, "lquery")) },
            flags,
          );
        case "move":
        case "copy":
          return runMoveOrCopy(client, command, flags, args);
        default:
          throw new InputError(usage);
      }
    });
  } finally {
    await shutdown.stop();
  }
}

async function runSearch(client: Index, flags: Flags): Promise<void> {
  const rawSelect = optionalFlag(flags, "select");
  let select: ReturnType<typeof parseSelectFields> | undefined;
  if (rawSelect !== undefined) {
    try {
      select = parseSelectFields(rawSelect);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InputError(`Invalid --select: ${message}`);
    }
  }

  const result = {
    results: await client.search(
      searchParamsSchema.parse(await resolvedSearchParams(flags, true)),
    ),
  };
  output(
    select === undefined
      ? { results: result.results.map(presentRecord) }
      : projectSearchEnvelope(result, select),
    flags,
  );
}

function assertOutputFormatApplies(command: string, flags: Flags): void {
  if (!flags.has("ndjson")) return;
  if (!["search", "list", "tree"].includes(command)) {
    throw new InputError("--ndjson applies only to search, list, and tree");
  }
}

async function runCreate(client: Index, flags: Flags): Promise<void> {
  const file = optionalFlag(flags, "file");
  const format = optionalFlag(flags, "format");
  if (format !== undefined && !["json", "json5", "yaml"].includes(format)) {
    throw new InputError("create --format must be json, json5, or yaml");
  }
  if (file !== undefined) {
    const conflicting = [
      "content",
      "tree",
      "name",
      "meta",
      "temporal",
      "id",
      "replace",
      "ignore",
    ].find((name) => flags.has(name));
    if (conflicting !== undefined) {
      throw new InputError(`--file cannot be combined with --${conflicting}`);
    }
    const record = await readStructuredFile(file, format);
    return outputCreated(
      client,
      await client.insert(recordInputSchema.parse(record)),
      flags,
    );
  }
  if (format !== undefined) throw new InputError("--format requires --file");

  const content = optionalFlag(flags, "content");
  if (content === undefined) throw new InputError("--content is required");
  const record = {
    content,
    ...(optionalFlag(flags, "tree") === undefined
      ? {}
      : { tree: optionalFlag(flags, "tree") }),
    ...(optionalFlag(flags, "name") === undefined
      ? {}
      : { name: optionalFlag(flags, "name") }),
    ...(optionalFlag(flags, "meta") === undefined
      ? {}
      : { meta: parseJsonObject(requiredFlag(flags, "meta"), "meta") }),
    ...(optionalFlag(flags, "temporal") === undefined
      ? {}
      : {
          temporal: parseTemporal(requiredFlag(flags, "temporal"), "temporal"),
        }),
    ...(optionalFlag(flags, "id") === undefined
      ? {}
      : { id: optionalFlag(flags, "id") }),
  };
  if (flags.has("replace") || flags.has("ignore")) {
    return outputCreated(
      client,
      await client.upsert(recordInputSchema.parse(record), {
        onConflict: flags.has("ignore") ? "ignore" : "replace",
      }),
      flags,
    );
  }
  return outputCreated(
    client,
    await client.insert(recordInputSchema.parse(record)),
    flags,
  );
}

async function runGet(
  client: Index,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  if (args.length === 1)
    return output(
      { record: presentRecord(await client.get(args[0] as string)) },
      flags,
    );
  if (args.length === 2) {
    return output(
      {
        record: presentRecord(
          await client.getByName(args[0] as string, args[1] as string),
        ),
      },
      flags,
    );
  }
  throw new InputError("get requires <id> or <tree> <name>");
}

async function runUpdate(
  client: Index,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const id = args[0];
  if (id === undefined || args.length !== 1)
    throw new InputError("update requires <id>");
  const inputFormat = optionalFlag(flags, "input-format");
  if (
    inputFormat !== undefined &&
    !["json", "json5", "yaml"].includes(inputFormat)
  ) {
    throw new InputError("--input-format must be json, json5, or yaml");
  }
  const inputFlag = optionalFlag(flags, "input");
  if (inputFormat !== undefined && inputFlag === undefined) {
    throw new InputError("--input-format requires --input");
  }
  const input = await readStructuredInput(inputFlag, inputFormat);
  const fieldNames = ["content", "tree", "name", "meta", "temporal"];
  if (input !== undefined) {
    const conflicting = fieldNames.find((name) => flags.has(name));
    if (conflicting !== undefined) {
      throw new InputError(`--input cannot be combined with --${conflicting}`);
    }
  }
  const patch =
    input ??
    Object.fromEntries(
      fieldNames
        .filter((name) => flags.has(name))
        .map((name) => {
          const value = optionalFlag(flags, name);
          if (value === undefined)
            throw new InputError(`--${name} requires a value`);
          if (name === "meta") return [name, parseJsonObject(value, name)];
          if (name === "temporal") {
            return [name, value === "" ? null : parseTemporal(value, name)];
          }
          if (name === "name") return [name, value === "" ? null : value];
          return [name, value];
        }),
    );
  return output(
    {
      record: presentRecord(
        await client.patch(
          id,
          requiredFlag(flags, "version-hash"),
          patchInputSchema.parse(patch),
        ),
      ),
    },
    flags,
  );
}

async function runDelete(
  client: Index,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const tree = optionalFlag(flags, "tree");
  if (tree !== undefined) {
    if (args.length > 0)
      throw new InputError("--tree cannot be combined with record addressing");
    if (!flags.has("dry-run") && !flags.has("yes")) {
      throw new InputError("deleting a tree requires --yes (or use --dry-run)");
    }
    return output(
      await client.deleteTree(tree, { dryRun: flags.has("dry-run") }),
      flags,
    );
  }
  if (flags.has("dry-run") || flags.has("yes")) {
    throw new InputError("--dry-run and --yes apply only to --tree deletion");
  }
  if (args.length === 1) {
    await client.delete(args[0] as string);
    return output({}, flags);
  }
  if (args.length === 2) {
    await client.deleteByName(args[0] as string, args[1] as string);
    return output({}, flags);
  }
  throw new InputError("delete requires <id>, <tree> <name>, or --tree <path>");
}

async function runImport(
  client: Index,
  flags: Flags,
  files: readonly string[],
): Promise<void> {
  const summary = await importRecords(client, {
    files,
    format: optionalFlag(flags, "format"),
    recursive: flags.has("recursive"),
    defaultTree: optionalFlag(flags, "tree"),
    mode: flags.has("replace")
      ? "replace"
      : flags.has("ignore")
        ? "ignore"
        : "error",
    dryRun: flags.has("dry-run"),
    failFast: flags.has("fail-fast"),
    verbose: flags.has("verbose"),
  });
  output(summary, flags);
  if (summary.failed > 0) process.exitCode = 1;
}

async function runExport(
  client: Index,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  if (hasExplicitOutputFormat(flags)) {
    throw new InputError(
      "export uses --format, not the global display-format flags",
    );
  }
  const format = optionalFlag(flags, "format") ?? "ndjson";
  if (!["ndjson", "json", "yaml", "md"].includes(format)) {
    throw new InputError("--format must be ndjson, json, yaml, or md");
  }
  const rawLimit = optionalFlag(flags, "limit");
  const summary = await exportRecords(client, {
    file: args[0],
    format: format as "ndjson" | "json" | "yaml" | "md",
    limit: rawLimit === undefined ? 0 : nonnegativeInteger(rawLimit, "limit"),
    search: (await exportSearchParams(flags)) as never,
  });
  console.error(
    `exported ${summary.exported} record(s); ${summary.withoutEmbedding} without an embedding`,
  );
}

async function exportSearchParams(
  flags: Flags,
): Promise<Record<string, unknown>> {
  const withoutLimit = new Map(flags);
  withoutLimit.delete("limit");
  return resolvedSearchParams(withoutLimit, false);
}

async function outputCreated(
  client: Index,
  write: { readonly id: string; readonly status: string },
  flags: Flags,
): Promise<void> {
  const fetched = presentRecord(await client.get(write.id));
  output({ result: write, record: fetched }, flags);
}

async function runTree(
  client: Index,
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const root = args[0] ?? "";
  const levels = optionalFlag(flags, "levels");
  const result = {
    entries: await client.treeView(
      root,
      levels === undefined
        ? {}
        : { levels: nonnegativeInteger(levels, "levels") },
    ),
  };
  if (hasExplicitOutputFormat(flags)) return output(result, flags);
  renderTree(result.entries, root);
}

async function runMoveOrCopy(
  client: Index,
  command: "move" | "copy",
  flags: Flags,
  args: readonly string[],
): Promise<void> {
  const [source, destination] = args;
  if (source === undefined || destination === undefined || args.length !== 2) {
    throw new InputError(`${command} requires <source> <destination>`);
  }
  const options = { dryRun: flags.has("dry-run") };
  output(
    command === "move"
      ? await client.moveTree(source, destination, options)
      : await client.copyTree(source, destination, options),
    flags,
  );
}

function output(value: unknown, flags: Flags): void {
  writeStructuredOutput(value, outputFormat(flags));
}

function renderTree(
  entries: readonly { readonly tree: string; readonly count: number }[],
  root: string,
): void {
  // Group by parent so connectors reflect each node's own siblings.
  const children = new Map<string, { tree: string; count: number }[]>();
  for (const entry of entries) {
    if (entry.tree === root) continue;
    const parent = entry.tree.split(".").slice(0, -1).join(".");
    const siblings = children.get(parent) ?? [];
    siblings.push(entry);
    children.set(parent, siblings);
  }
  const rootEntry = entries.find((entry) => entry.tree === root);
  console.log(`${root === "" ? "." : root} (${rootEntry?.count ?? 0})`);
  const render = (parent: string, prefix: string): void => {
    const siblings = [...(children.get(parent) ?? [])].sort((left, right) =>
      left.tree.localeCompare(right.tree),
    );
    for (const [index, entry] of siblings.entries()) {
      const last = index === siblings.length - 1;
      const label = entry.tree.split(".").at(-1) ?? entry.tree;
      console.log(
        `${prefix}${last ? "└── " : "├── "}${label} (${entry.count})`,
      );
      render(entry.tree, `${prefix}${last ? "    " : "│   "}`);
    }
  };
  render(root, "");
}

/** Map search/count flags to core options; exported for fast unit tests. */
export function paramsFromFlags(command: string, flags: Flags): unknown {
  if (command === "count") {
    const names = ["tree", "lquery", "ltxtquery"].filter((name) =>
      flags.has(name),
    );
    const [name] = names;
    if (names.length !== 1 || name === undefined) {
      throw new InputError(
        "count requires exactly one of --tree, --lquery, or --ltxtquery",
      );
    }
    const selector = optionalFlag(flags, name);
    if (selector === undefined)
      throw new InputError(`--${name} requires a value`);
    return {
      selector: { [name]: selector },
      ...(optionalFlag(flags, "limit") === undefined
        ? {}
        : { limit: positiveInteger(requiredFlag(flags, "limit"), "limit") }),
    };
  }
  if (command === "search") {
    if (flags.has("filter") || flags.has("filter-file")) {
      throw new InputError(
        "filter expressions require asynchronous input resolution",
      );
    }
    return searchParamsFromFlags(flags, true);
  }
  throw new InputError(`cannot derive ${command} params from flags`);
}

async function resolvedSearchParams(
  flags: Flags,
  requireCriterion: boolean,
): Promise<Record<string, unknown>> {
  const expression = await filterExpressionFromFlags(flags);
  return searchParamsFromFlags(flags, requireCriterion, expression);
}

function searchParamsFromFlags(
  flags: Flags,
  requireCriterion: boolean,
  expression?: Filter,
): Record<string, unknown> {
  const semantic = optionalFlag(flags, "semantic");
  const fulltext = optionalFlag(flags, "fulltext");
  const leaves = filterLeavesFromFlags(flags);
  if (expression !== undefined && leaves.length > 0) {
    throw new InputError(
      "--filter and --filter-file cannot be combined with flat filter flags",
    );
  }
  if (
    requireCriterion &&
    semantic === undefined &&
    fulltext === undefined &&
    leaves.length === 0 &&
    expression === undefined
  ) {
    throw new InputError(
      "search requires a ranking flag (--semantic, --fulltext) or a filter flag",
    );
  }
  return {
    ...(semantic === undefined ? {} : { semantic }),
    ...(fulltext === undefined ? {} : { fulltext }),
    ...(expression !== undefined
      ? { filter: expression }
      : leaves.length === 0
        ? {}
        : { filter: conjoin(leaves) }),
    ...numericSearchOptions(flags),
    ...(optionalFlag(flags, "order") === undefined
      ? {}
      : {
          order: enumeration(requiredFlag(flags, "order"), "order", [
            "asc",
            "desc",
          ]),
        }),
    ...(optionalFlag(flags, "after") === undefined
      ? {}
      : { after: optionalFlag(flags, "after") }),
    ...(optionalFlag(flags, "before") === undefined
      ? {}
      : { before: optionalFlag(flags, "before") }),
  };
}

const filterLeafFlags = [
  { key: "tree", parse: (raw: string) => raw },
  { key: "lquery", parse: (raw: string) => raw },
  { key: "ltxtquery", parse: (raw: string) => raw },
  { key: "meta", parse: (raw: string) => parseJsonObject(raw, "meta") },
  { key: "metaPredicate", parse: (raw: string) => raw },
  {
    key: "temporalWithin",
    parse: (raw: string) => parseRange(raw, "temporal-within"),
  },
  {
    key: "temporalOverlaps",
    parse: (raw: string) => parseRange(raw, "temporal-overlaps"),
  },
  { key: "temporalBefore", parse: (raw: string) => raw },
  { key: "temporalAfter", parse: (raw: string) => raw },
  { key: "temporalContains", parse: (raw: string) => raw },
  { key: "regexp", parse: (raw: string) => raw },
] as const satisfies readonly {
  key: string;
  parse: (raw: string) => unknown;
}[];

export const flagNameFor = kebabCase;
export const filterFlagNames: readonly string[] = filterLeafFlags.map((leaf) =>
  flagNameFor(leaf.key),
);

function filterLeavesFromFlags(
  flags: Flags,
): readonly Record<string, unknown>[] {
  const leaves: Record<string, unknown>[] = [];
  for (const { key, parse } of filterLeafFlags) {
    const raw = optionalFlag(flags, flagNameFor(key));
    if (raw !== undefined) leaves.push({ [key]: parse(raw) });
  }
  return leaves;
}

function conjoin(
  leaves: readonly Record<string, unknown>[],
): Record<string, unknown> {
  const [first] = leaves;
  if (first === undefined)
    throw new InputError("expected at least one filter leaf");
  return leaves.length === 1 ? first : { and: [...leaves] };
}

function parseRange(raw: string, name: string): readonly [string, string] {
  const separator = raw.indexOf(",");
  if (separator === -1)
    throw new InputError(`--${name} must be a "start,end" range`);
  const start = raw.slice(0, separator).trim();
  const end = raw.slice(separator + 1).trim();
  if (start === "" || end === "")
    throw new InputError(`--${name} must be a "start,end" range`);
  return [start, end];
}

function parseTemporal(
  raw: string,
  name: string,
): readonly [string] | readonly [string, string] {
  return raw.includes(",") ? parseRange(raw, name) : [raw];
}

function numericSearchOptions(flags: Flags): Record<string, number> {
  const options: Record<string, number> = {};
  for (const name of ["limit", "candidate-limit"]) {
    const raw = optionalFlag(flags, name);
    if (raw !== undefined)
      options[camelCase(name)] = positiveInteger(raw, name);
  }
  for (const name of [
    "semantic-threshold",
    "semantic-weight",
    "fulltext-weight",
  ]) {
    const raw = optionalFlag(flags, name);
    if (raw !== undefined) options[camelCase(name)] = unitInterval(raw, name);
  }
  return options;
}
