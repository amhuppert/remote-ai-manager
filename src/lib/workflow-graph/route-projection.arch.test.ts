import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * The route projection is the ONE place route semantics are decided, and the
 * graph page, the inspector and the CLI outline all have to derive the same
 * verdicts the scheduler does. That only holds while the module stays
 * importable from a browser bundle — and nothing but `bun run build` reports a
 * Node-only dependency creeping onto the path, long after the change looks
 * green.
 *
 * The raw output lookup underneath it carries the stricter rule: no imports at
 * all, so nothing can be dragged in behind it.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");

const PROJECTION = "src/lib/workflow-graph/route-projection.ts";
const OUTPUT_LOOKUP = "src/lib/workflow-graph/output-lookup.ts";

const NODE_BUILTIN_IMPORT = /from\s+["']node:[^"']+["']/;
const ANY_IMPORT = /^\s*import\s+(?!type\s)[^;]*?from\s+["']([^"']+)["']/gm;

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

describe("the route projection stays browser-safe (D4 R2)", () => {
  it.each([PROJECTION, OUTPUT_LOOKUP])(
    "%s imports no Node builtin",
    (relPath) => {
      expect(read(relPath)).not.toMatch(NODE_BUILTIN_IMPORT);
    },
  );

  it("the raw output lookup has no imports at all", () => {
    const imports = [...read(OUTPUT_LOOKUP).matchAll(/^\s*import\s/gm)];
    expect(imports).toEqual([]);
  });

  it("the projection's only runtime dependencies are the lookup and the shared subset evaluator", () => {
    // Type-only imports are erased, so they cannot drag anything into a bundle;
    // a new VALUE import is the thing that has to be argued for. A second guard
    // evaluator in particular is what the single-source rule forbids.
    const valueImports = [...read(PROJECTION).matchAll(ANY_IMPORT)].map(
      (match) => match[1],
    );

    expect(valueImports).toEqual([
      "@/lib/workflow-graph/output-lookup",
      "@/lib/workflows/primitives/output-schema-subset",
    ]);
  });
});
