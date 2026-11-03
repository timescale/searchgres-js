import { rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

/** Build-time only: consumers receive ordinary Node-compatible ESM. */
export async function buildCore(directory = join(root, "packages/core")) {
  const outdir = join(directory, "dist");
  await rm(outdir, { recursive: true, force: true });
  try {
    const types = Bun.spawn(
      [
        join(root, "bun"),
        "x",
        "--no-install",
        "tsc",
        "-p",
        join(directory, "tsconfig.build.json"),
      ],
      { cwd: directory, stdout: "inherit", stderr: "inherit" },
    );
    if ((await types.exited) !== 0) {
      throw new Error("Core declaration build failed");
    }
    const result = await Bun.build({
      entrypoints: [join(directory, "src/index.ts")],
      root: join(directory, "src"),
      outdir,
      target: "node",
      format: "esm",
      packages: "external",
      // Explicitly cover re-exports too: Bun 1.4.4 ignores text attributes
      // on `export ... from` and otherwise emits a runtime SQL asset path.
      loader: { ".sql": "text" },
      sourcemap: "linked",
    });
    if (!result.success) {
      throw new AggregateError(result.logs, "Core JavaScript build failed");
    }
  } catch (error) {
    // A failed build must not leave an old or partially publishable artifact.
    await rm(outdir, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) await buildCore();
