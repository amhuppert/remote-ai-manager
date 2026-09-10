// @vitest-inputs src/components/workflow-config/OutputSchemaField.tsx
// @vitest-inputs src/features/workflows-builder/components/WorkflowBuilderEditor.tsx
// @vitest-inputs src/lib/workflow-graph/definition-validation.ts
// @vitest-inputs src/lib/workflow-graph/output-schema-validation.ts
// @vitest-inputs src/lib/workflows/primitives/output-schema-subset.ts
// @vitest-inputs src/lib/workflows/primitives/structured-output-gate.ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Architecture test for the ONE property that makes D2's single-sourcing
 * possible: the output-schema subset module — descriptor, guidance messages and
 * declaration walker — must stay importable from a `"use client"` component.
 *
 * The definition validator reaches it from `definition-validation.ts`, which the builder
 * editor (a client component) imports. If any module on that path pulls a
 * Node-only dependency, the browser bundle breaks — and nothing but
 * `bun run build` reports it, long after the change looks green. So the path is
 * pinned here: every module from the client entry point down to the subset
 * carries no `node:` import, and the subset itself carries no import at all.
 *
 * The alternative — letting the UI re-derive its own keyword list to dodge the
 * import — is precisely the lint/validator drift R1.3 forbids.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/**
 * The client-reachable chain, from the `"use client"` entry point down. Listed
 * explicitly rather than crawled: the point is that THIS path stays clean, and
 * a new hop appearing on it should be a deliberate addition here.
 */
const CLIENT_REACHABLE_CHAIN = [
  "src/features/workflows-builder/components/WorkflowBuilderEditor.tsx",
  "src/lib/workflow-graph/definition-validation.ts",
  "src/lib/workflow-graph/output-schema-validation.ts",
  "src/components/workflow-config/OutputSchemaField.tsx",
  "src/lib/workflows/primitives/output-schema-subset.ts",
] as const;

/** The editor whose red lines must BE the server's refusals (R1.3). */
const SCHEMA_FIELD = "src/components/workflow-config/OutputSchemaField.tsx";

const SUBSET_MODULE = "src/lib/workflows/primitives/output-schema-subset.ts";

const NODE_BUILTIN_IMPORT = /from\s+["']node:[^"']+["']/;
const ANY_IMPORT = /^\s*import\s+[^;]*?from\s+["']([^"']+)["']/gm;

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

describe("output-schema subset module stays browser-safe (D2, R1.3)", () => {
  it.each(CLIENT_REACHABLE_CHAIN)("%s imports no Node builtin", (relPath) => {
    expect(read(relPath)).not.toMatch(NODE_BUILTIN_IMPORT);
  });

  it("the subset module has no imports at all, so nothing can be dragged in behind it", () => {
    const imports = [...read(SUBSET_MODULE).matchAll(ANY_IMPORT)].map(
      (match) => match[1],
    );
    expect(imports).toEqual([]);
  });

  it("the definition validator reaches the subset directly, not through the logging gate", () => {
    // `structured-output-gate.ts` re-exports the same functions but creates a
    // logger at module scope, which imports `node:fs`.
    const source = read("src/lib/workflow-graph/output-schema-validation.ts");
    expect(source).toContain("primitives/output-schema-subset");
    expect(source).not.toContain("primitives/structured-output-gate");
  });

  it("the schema editor lints through the subset walker, not a list of its own", () => {
    const source = read(SCHEMA_FIELD);
    expect(source).toContain("primitives/output-schema-subset");
    expect(source).toContain("validateOutputSchemaDeclaration");
    // Going through the gate would drag `node:fs` into the browser bundle; a
    // literal keyword list would reintroduce exactly the drift D2 removed.
    expect(source).not.toContain("primitives/structured-output-gate");
    for (const keyword of [
      "anyOf",
      "allOf",
      "prefixItems",
      "patternProperties",
    ]) {
      expect(source).not.toContain(keyword);
    }
  });

  it("the gate module still re-exports the subset for server callers", () => {
    const source = read(
      "src/lib/workflows/primitives/structured-output-gate.ts",
    );
    expect(source).toContain("./output-schema-subset");
    expect(source).toContain("validateJsonSchemaSubset");
    expect(source).toContain("validateOutputSchemaDeclaration");
  });
});
