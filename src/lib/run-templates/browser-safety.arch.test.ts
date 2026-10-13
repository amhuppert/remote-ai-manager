// @vitest-inputs src/**
import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  readValueGraph,
  shortestImportPath,
  valueImportSpecifiers,
} from "../../../scripts/module-imports";

/**
 * The template editor and its fetchers validate and lint with the server's own
 * document schema and rules, so every module they reach must load in a
 * browser. A Node built-in anywhere on that graph breaks the client bundle.
 * Unit tests never compile the pages, so without this walk the break shows
 * only when a page is compiled (visited under `next dev`, or built).
 */
const repoRoot = path.resolve(__dirname, "../../..");

const BROWSER_ENTRIES = [
  "src/features/runs/RunTemplatesPage.tsx",
  "src/features/runs/RunTemplateEditorPage.tsx",
  "src/lib/run-templates/queries.ts",
  "src/lib/run-templates/mutations.ts",
  "src/lib/run-templates/sse-reactions.ts",
  "src/features/runs/template-model.ts",
  "src/lib/run-templates/document.ts",
  "src/lib/run-templates/parameters.ts",
  "src/lib/run-templates/schemas.ts",
  "src/lib/runs/settings.ts",
  "src/lib/config/settings-cascade.ts",
];

describe("run template browser safety", () => {
  it("reaches no Node built-in from the modules the template editor imports", () => {
    const graph = readValueGraph(repoRoot, BROWSER_ENTRIES);
    const scripts = [...graph.keys()].filter((file) =>
      /\.[cm]?[jt]sx?$/.test(file),
    );
    const offenders = scripts.flatMap((file) =>
      valueImportSpecifiers(
        file,
        readFileSync(path.join(repoRoot, file), "utf8"),
      )
        .filter((specifier) => isBuiltin(specifier))
        .map((specifier) => {
          const chain = BROWSER_ENTRIES.map((entry) =>
            shortestImportPath(graph, entry, file),
          ).find((found) => found !== null);
          return `${(chain ?? [file]).join(" -> ")} -> ${specifier}`;
        }),
    );
    expect(offenders).toEqual([]);
  }, 30_000);
});
