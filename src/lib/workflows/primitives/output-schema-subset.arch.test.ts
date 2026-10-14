// @vitest-inputs src/features/runs/components/template/TemplateEditor.tsx
// @vitest-inputs src/lib/runs/workflow-definition.ts
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
 * The run template editor and run definition validator import the subset
 * directly. Node-only dependencies on those paths would break the browser
 * bundle, so both consumers and the subset are pinned here. Each carries no
 * `node:` import, and the subset itself carries no import at all.
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
const SCHEMA_FIELD = "src/features/runs/components/template/TemplateEditor.tsx";
const DEFINITION_VALIDATOR = "src/lib/runs/workflow-definition.ts";
const CLIENT_REACHABLE_CHAIN = [
  SCHEMA_FIELD,
  DEFINITION_VALIDATOR,
  "src/lib/workflows/primitives/output-schema-subset.ts",
] as const;

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

  it.each([SCHEMA_FIELD, DEFINITION_VALIDATOR])(
    "%s validates declarations through the browser-safe subset owner",
    (file) => {
      const source = read(file);
      expect(source).toContain("primitives/output-schema-subset");
      expect(source).toContain("validateOutputSchemaDeclaration");
      expect(source).not.toContain("primitives/structured-output-gate");
    },
  );

  it("the gate module still re-exports the subset for server callers", () => {
    const source = read(
      "src/lib/workflows/primitives/structured-output-gate.ts",
    );
    expect(source).toContain("./output-schema-subset");
    expect(source).toContain("validateJsonSchemaSubset");
    expect(source).toContain("validateOutputSchemaDeclaration");
  });
});
