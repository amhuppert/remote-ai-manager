import { readdirSync } from "node:fs";
import path from "node:path";

// UI follows route imports; whole UI directories would include story fixtures.
export const PRODUCTION_ENTRIES = [
  "src/app",
  "src/instrumentation.ts",
  "src/instrumentation.node.ts",
  "src/middleware.ts",
  "src/cli/index.ts",
  "src/lib/agent-backends/cursor/worker/main.ts",
];

export function productionEntryFiles(root: string): string[] {
  return PRODUCTION_ENTRIES.flatMap((entry) =>
    entry === "src/app"
      ? readdirSync(path.join(root, entry), {
          recursive: true,
          encoding: "utf8",
        })
          .filter(
            (file) =>
              /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|stories)\./.test(file),
          )
          .map((file) => `${entry}/${file}`)
      : [entry],
  ).sort();
}
