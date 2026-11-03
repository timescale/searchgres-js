// Cross-compile one native executable for every release target. All binary
// surfaces emit into the repository-level dist/ directory so platform bundles
// cannot be confused with package-local JavaScript/type build output.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { signMacosBinary } from "./macos-sign.ts";

const [name, entrypoint] = Bun.argv.slice(2);
if (name === undefined || entrypoint === undefined) {
  console.error(
    "usage: compile-targets.ts <binary-name> <entrypoint>  (run from a package)",
  );
  process.exit(1);
}

const outputDirectory = fileURLToPath(new URL("../dist/", import.meta.url));
mkdirSync(outputDirectory, { recursive: true });

const targets = [
  { target: "bun-linux-x64", suffix: "linux-amd64" },
  { target: "bun-linux-arm64", suffix: "linux-arm64" },
  { target: "bun-windows-x64", suffix: "windows-amd64.exe" },
  { target: "bun-windows-arm64", suffix: "windows-arm64.exe" },
  { target: "bun-darwin-x64", suffix: "macos-amd64" },
  { target: "bun-darwin-arm64", suffix: "macos-arm64" },
] as const;

for (const { target, suffix } of targets) {
  const output = join(outputDirectory, `${name}-${suffix}`);
  console.log(`Compiling ${target} → ${output}`);
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "build",
      entrypoint,
      "--compile",
      "--loader=.sql:text",
      `--target=${target}`,
      `--outfile=${output}`,
    ],
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) process.exit(result.exitCode);

  if (suffix.startsWith("macos-")) signMacosBinary(output);

  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(output).arrayBuffer())
    .digest("hex");
  await Bun.write(`${output}.sha256`, `${digest}  ${name}-${suffix}\n`);
}
