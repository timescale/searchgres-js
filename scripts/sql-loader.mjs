// Development-only support for Node source tests. Published core embeds SQL.
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:") && new URL(url).pathname.endsWith(".sql")) {
      return {
        format: "module",
        source: `export default ${JSON.stringify(readFileSync(new URL(url), "utf8"))};`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});
