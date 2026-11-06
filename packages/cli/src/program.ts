import { Command, InvalidArgumentError, Option } from "commander";
import { LIBRARY_VERSION } from "searchgres";
import { filterFlagNames, flagsFromOptions, runCommand } from "./cli.ts";
import { generateConfig, provision } from "./config/provision.ts";
import { runEmbeddings } from "./embeddings.ts";
import { outputFormat, writeStructuredOutput } from "./format.ts";
import { runMcp } from "./mcp/command.ts";
import { InputError } from "./runtime/report.ts";

/** Commander owns command discovery, help, arguments, and shell-facing errors. */
export async function runProgram(argv: readonly string[]): Promise<void> {
  if (
    argv.includes("--no-env-file") &&
    argv.some((arg) => arg === "--env-file" || arg.startsWith("--env-file="))
  ) {
    throw new InputError(
      "--env-file and --no-env-file cannot be used together",
    );
  }
  const program = new Command()
    .name("searchgres")
    .description(
      "Postgres-native search: provisioning, records, trees, embeddings, and MCP for one configured index.",
    )
    .showSuggestionAfterError()
    .exitOverride()
    .configureHelp({ showGlobalOptions: true })
    .version(LIBRARY_VERSION)
    .option(
      "--config <path>",
      "config path; defaults to SEARCHGRES_CONFIG or ./searchgres.yaml",
    )
    .option(
      "--env-file <path>",
      "environment file; defaults to .env next to config",
    )
    .option("--no-env-file", "do not load an environment file")
    .addOption(
      new Option("--yaml", "emit YAML (the default)").conflicts([
        "json",
        "ndjson",
      ]),
    )
    .addOption(new Option("--json", "emit JSON").conflicts(["yaml", "ndjson"]))
    .addOption(
      new Option("--ndjson", "emit one JSON object per line").conflicts([
        "yaml",
        "json",
      ]),
    );

  action(
    program
      .command("info")
      .description("show index configuration and embedding queue status"),
    "info",
  );
  action(
    program
      .command("config")
      .description("generate offline configuration (interactive on a TTY)")
      .option("--schema <schema>", "index schema to put in configuration")
      .option("--database-url-env <name>", "database URL environment variable")
      .option("--embedding-model <model>", "OpenAI-compatible model")
      .option("--dimensions <n>", "vector dimensions")
      .option("--vector-type <type>", "vector or halfvec")
      .option("--vector-index <method>", "hnsw or prism")
      .option("--api-key-env <name>", "provider key environment variable")
      .option("--base-url <url>", "OpenAI-compatible API root")
      .option("--base-url-env <name>", "API root environment variable")
      .option("--tokenizer <preset>", "exact tokenizer preset")
      .option("--max-tokens <n>", "content token budget")
      .option("--dry-run", "print config without writing files"),
    "config",
  );
  action(
    program
      .command("init")
      .description("create the configured index")
      .option(
        "--if-not-exists",
        "validate and accept an existing matching index",
      ),
    "init",
  );
  action(
    program
      .command("migrate")
      .description("migrate the configured index to the current schema format"),
    "migrate",
  );
  action(
    program
      .command("destroy")
      .description("drop the configured index")
      .option("--yes", "confirm destruction"),
    "destroy",
  );
  action(
    program
      .command("mcp")
      .description("run MCP on stdio with background embedding workers")
      .option("--workers <n>", "worker count; 0 disables background embedding")
      .option("--read-only", "omit mutating tools and disable workers"),
    "mcp",
  );
  const embeddings = program
    .command("embeddings")
    .description("process and inspect the embedding queue");
  action(
    embeddings
      .command("process")
      .description("drain currently claimable work and exit")
      .option("--batch-size <n>", "records per batch")
      .option("--max-batches <n>", "maximum batches; 1 for one batch")
      .option("--max-duration <duration>", "budget checked between batches"),
    "embeddings process",
  );
  action(
    embeddings
      .command("worker")
      .description("run a continuous worker pool")
      .option("--workers <n>", "number of concurrent workers")
      .option("--batch-size <n>", "records per batch")
      .option("--interval <duration>", "idle poll interval"),
    "embeddings worker",
  );
  action(
    embeddings.command("status").description("show queue statistics"),
    "embeddings status",
  );
  action(
    embeddings
      .command("failures")
      .description("list current terminal failures")
      .option("--limit <n>", "page size, at most 1000")
      .option("--after <queue-id>", "decimal bigint keyset cursor"),
    "embeddings failures",
  );
  action(
    embeddings
      .command("retry")
      .description("retry explicit failures or one traversal of all failures")
      .option("--queue-id <ids...>", "decimal queue IDs")
      .option("--all", "list and retry all current failures")
      .option("--yes", "confirm --all"),
    "embeddings retry",
  );
  action(
    embeddings
      .command("prune")
      .description("remove old terminal queue rows")
      .requiredOption("--older-than <duration>", "retention window")
      .option("--yes", "confirm pruning"),
    "embeddings prune",
  );

  const vectorIndex = program
    .command("vector-index")
    .description("inspect and rebuild the vector index");
  action(
    vectorIndex
      .command("stats")
      .description("show vector index shape, size, and cluster health"),
    "vector-index stats",
  );
  action(
    vectorIndex
      .command("reindex")
      .description("rebuild the vector index")
      .option("--concurrently", "run REINDEX INDEX CONCURRENTLY")
      .option("--nlist <n|auto>", "pin prism nlist or reset to auto")
      .option("--lock-timeout <duration>", "lock wait timeout (e.g. 5s, 0ms)")
      .option(
        "--statement-timeout <duration>",
        "statement timeout (e.g. 30s, 0ms)",
      ),
    "vector-index reindex",
  );

  const create = program
    .command("create")
    .description("create one record")
    .option("--content <text>", "record content")
    .option("--file <path>", "read one structured record; - reads stdin")
    .option("--format <format>", "file format: json, json5, or yaml")
    .option("--tree <path>", "raw dotted tree path")
    .option("--name <name>", "record name")
    .option("--meta <json>", "metadata as a JSON object")
    .option("--temporal <start[,end]>", "temporal instant or interval")
    .option("--id <uuid>", "explicit UUIDv7")
    .addOption(
      new Option("--replace", "replace a conflicting named record").conflicts(
        "ignore",
      ),
    )
    .addOption(
      new Option("--ignore", "keep a conflicting named record").conflicts(
        "replace",
      ),
    );
  action(create, "create");

  action(
    program
      .command("get")
      .description("get one record by id or by tree and name")
      .argument("<reference...>", "<id> or <tree> <name>"),
    "get",
  );

  const update = program
    .command("update")
    .description("update one record optimistically")
    .argument("<id>", "record UUIDv7")
    .requiredOption("--version-hash <hash>", "current record version hash")
    .option("--content <text>", "new content")
    .option("--tree <path>", "new raw dotted tree path")
    .option("--name <name>", "new name; an empty value clears it")
    .option("--meta <json>", "replacement metadata JSON object")
    .option("--temporal <start[,end]>", "new instant/interval; empty clears it")
    .option("--input <value>", "structured patch: inline, @file, or -")
    .option("--input-format <format>", "json, json5, or yaml");
  action(update, "update");

  const deletion = program
    .command("delete")
    .description("delete one record, or an inclusive subtree")
    .argument("[reference...]", "<id> or <tree> <name>")
    .option("--tree <path>", "delete this inclusive subtree")
    .option("--dry-run", "report subtree count without deleting")
    .option("--yes", "confirm subtree deletion");
  action(deletion, "delete");

  const search = program
    .command("search")
    .description("run filter, full-text, semantic, or hybrid search")
    .option("--semantic <text>", "semantic query text")
    .option("--fulltext <text>", "full-text query text");
  addFilterOptions(search);
  search
    .option("--limit <n>", "maximum result count")
    .option("--candidate-limit <n>", "per-arm candidate pool size")
    .option("--semantic-threshold <n>", "minimum cosine similarity in [0,1]")
    .option("--semantic-weight <n>", "semantic RRF weight in [0,1]")
    .option("--fulltext-weight <n>", "full-text RRF weight in [0,1]")
    .option(
      "--select <fields>",
      "comma-separated output fields, e.g. id,content:200,score",
    )
    .option("--order <direction>", "filter-only order: asc or desc")
    .option("--after <uuid>", "filter-only keyset cursor")
    .option("--before <uuid>", "reverse filter-only keyset cursor");
  action(search, "search");

  const importCommand = program
    .command("import")
    .description("import records from files, directories, or stdin")
    .argument("[files...]", "files/directories; - reads stdin")
    .option("-r, --recursive", "recursively import directories")
    .option("--format <format>", "force ndjson, json, yaml, or md")
    .option("--tree <path>", "default tree for records without one")
    .addOption(
      new Option("--replace", "replace conflicting named records").conflicts(
        "ignore",
      ),
    )
    .addOption(
      new Option("--ignore", "keep conflicting named records").conflicts(
        "replace",
      ),
    )
    .option("--dry-run", "parse and validate without writing")
    .option("--fail-fast", "stop on the first failed file or batch")
    .option("-v, --verbose", "print per-file progress to stderr");
  action(importCommand, "import");

  const exportCommand = program
    .command("export")
    .description("export filtered records to a file or stdout")
    .argument("[file]", "output file, or directory for Markdown")
    .option("--format <format>", "ndjson, json, yaml, or md", "ndjson");
  addFilterOptions(exportCommand);
  exportCommand.option("--limit <n>", "maximum records; 0 means all");
  action(exportCommand, "export");

  action(
    program
      .command("tree")
      .description("render a tree with descendant counts")
      .argument("[tree]", "root tree path")
      .option("--levels <n>", "maximum relative depth"),
    "tree",
  );
  action(
    program
      .command("count")
      .description("count records selected by a tree expression")
      .option("--tree <path>", "raw dotted tree path")
      .option("--lquery <query>", "ltree lquery")
      .option("--ltxtquery <query>", "ltree ltxtquery")
      .option("--limit <n>", "cap the count"),
    "count",
  );
  action(
    program
      .command("list")
      .description("list matching tree nodes with counts")
      .requiredOption("--lquery <query>", "ltree lquery"),
    "list",
  );
  action(
    program
      .command("move")
      .description("move a subtree")
      .argument("<source>", "source tree path")
      .argument("<destination>", "destination tree path")
      .option("--dry-run", "report count without changing records"),
    "move",
  );
  action(
    program
      .command("copy")
      .description("copy a subtree with fresh record ids")
      .argument("<source>", "source tree path")
      .argument("<destination>", "destination tree path")
      .option("--dry-run", "report count without changing records"),
    "copy",
  );

  await program.parseAsync(["node", "searchgres", ...argv]);
}

function addFilterOptions(command: Command): void {
  command
    .option("--tree <path>", "records at or below a raw dotted tree path")
    .option("--lquery <query>", "ltree lquery")
    .option("--ltxtquery <query>", "ltree ltxtquery")
    .option("--meta <json>", "metadata containment as a JSON object")
    .option("--meta-predicate <jsonpath>", "JSONPath metadata predicate")
    .option("--temporal-within <start,end>", "record falls inside the window")
    .option("--temporal-overlaps <start,end>", "record overlaps the window")
    .option("--temporal-before <ts>", "record is strictly before this instant")
    .option("--temporal-after <ts>", "record is strictly after this instant")
    .option("--temporal-contains <ts>", "record contains this instant")
    .option(
      "--regexp <pattern>",
      "case-insensitive POSIX content regex; needs another filter",
    );

  const leafAttributes = filterFlagNames.map(optionAttribute);
  command
    .addOption(
      new Option("--filter <expression>", "explicit S-expression filter DSL")
        .argParser(singleOptionValue("--filter"))
        .conflicts(["filterFile", ...leafAttributes]),
    )
    .addOption(
      new Option(
        "--filter-file <path>",
        "read filter DSL from a UTF-8 file; - reads stdin",
      )
        .argParser(singleOptionValue("--filter-file"))
        .conflicts(["filter", ...leafAttributes]),
    );

  // Keep this assertion adjacent to registration: adding a leaf in cli.ts
  // without giving Commander a matching option should fail immediately.
  const registered = new Set(
    command.options.map((option) => option.attributeName()),
  );
  for (const name of filterFlagNames) {
    const attribute = optionAttribute(name);
    if (!registered.has(attribute))
      throw new Error(`missing --${name} registration`);
  }
}

function optionAttribute(name: string): string {
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function singleOptionValue(
  name: string,
): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError(`${name} may be specified only once`);
    }
    return value;
  };
}

function action(command: Command, name: string): void {
  command.action(async (...actionArgs: unknown[]) => {
    const invoked = actionArgs.at(-1) as Command;
    const flags = flagsFromOptions(invoked.optsWithGlobals());
    if (name === "config") return generateConfig(flags);
    if (name === "init" || name === "migrate" || name === "destroy") {
      if (flags.has("ndjson"))
        throw new InputError("--ndjson requires a collection command");
      writeStructuredOutput(await provision(name, flags), outputFormat(flags));
      return;
    }
    if (name === "mcp") return runMcp(flags);
    if (name.startsWith("embeddings "))
      return runEmbeddings(name.slice("embeddings ".length), flags);
    await runCommand(name, flags, invoked.args);
  });
}
