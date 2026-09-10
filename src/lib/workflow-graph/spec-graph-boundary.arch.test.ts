// @vitest-inputs src/lib/specs/**/*.ts src/features/spec-studio/**/*.{ts,tsx}
// @vitest-inputs src/cli/commands/spec/**/*.ts
// @vitest-inputs src/lib/workflow-graph/spec-bridge.ts
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SPEC_PRODUCTION_ROOTS = [
  "src/lib/specs",
  "src/cli/commands/spec",
  "src/features/spec-studio",
] as const;

const EXACT_LAUNCH_SYMBOLS = new Set([
  "workflowDefinitionMutationSchema",
  "WorkflowDefinitionMutation",
  "WorkflowDefinitionDraft",
]);

const PUBLIC_GRAPH_BOUNDARY_MODULES = new Set([
  "@/lib/workflow-graph/authored-launch-admission",
  "@/lib/workflow-graph/authored-context-outcome",
  "@/lib/workflow-graph/execution-contract-port",
  "@/lib/workflow-graph/execution-lifecycle-port",
  "@/lib/workflow-graph/production",
  "@/lib/workflow-graph/launch-presentation",
  // The prompt-projection seam: `execution-contract-port` already publishes
  // `GraphRolePromptProjection` in the contract signature a spec implements,
  // so the module owning that vocabulary and its renderer is part of the
  // public boundary rather than an internal reached around it.
  "@/lib/workflow-graph/prompt-composer",
  "@/lib/workflow-graph/spec-bridge",
  // Pure hashing over the resolved working definition — the audit-hash seam
  // spec start records (amended design D3). Server-only (node:crypto), so it
  // must NOT ride the client-consumed spec bridge.
  "@/lib/workflow-graph/working-definition-hash",
]);
const INDIRECT_GRAPH_SCHEMA_MODULES = new Set([
  "@/lib/workflows/plan-validation",
]);

function productionFiles(relativeDirectory: string): string[] {
  return readdirSync(path.join(REPO_ROOT, relativeDirectory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return productionFiles(relativePath);
    if (!entry.isFile() || !/\.(?:ts|tsx)$/.test(entry.name)) return [];
    if (
      /\.(?:test|stories)\.(?:ts|tsx)$/.test(entry.name) ||
      /(?:^|[.-])fixtures?\.(?:ts|tsx)$/.test(entry.name) ||
      entry.name.endsWith("-test-fixture.ts")
    ) {
      return [];
    }
    return [relativePath];
  });
}

function graphImportIssues(relativePath: string): string[] {
  const source = ts.createSourceFile(
    relativePath,
    readFileSync(path.join(REPO_ROOT, relativePath), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const issues: string[] = [];

  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const moduleName = statement.moduleSpecifier.text;
    if (INDIRECT_GRAPH_SCHEMA_MODULES.has(moduleName)) {
      issues.push(
        `${relativePath}: ${moduleName} is not the canonical launch schema module`,
      );
      continue;
    }
    if (!moduleName.startsWith("@/lib/workflow-graph/")) continue;
    const bindings = statement.importClause?.namedBindings;

    if (moduleName === "@/lib/workflow-graph/definition-schemas") {
      if (!bindings || !ts.isNamedImports(bindings)) {
        issues.push(`${relativePath}: launch schema imports must be named`);
        continue;
      }
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (!EXACT_LAUNCH_SYMBOLS.has(imported)) {
          issues.push(
            `${relativePath}: ${imported} is a graph field-level import`,
          );
        }
      }
      continue;
    }

    if (!PUBLIC_GRAPH_BOUNDARY_MODULES.has(moduleName)) {
      issues.push(
        `${relativePath}: ${moduleName} is not a public graph boundary`,
      );
    }
  }
  return issues;
}

describe("native SDD graph boundary", () => {
  it("allows only the exact launch schema and public admission/lifecycle/bridge modules", () => {
    const issues =
      SPEC_PRODUCTION_ROOTS.flatMap(productionFiles).flatMap(graphImportIssues);

    expect(issues).toEqual([]);
  });

  it("keeps the client-consumed spec bridge off the server-only start runtime", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src/lib/workflow-graph/spec-bridge.ts"),
      "utf8",
    );

    expect(source).not.toContain('from "./start-readiness"');
  });
});
