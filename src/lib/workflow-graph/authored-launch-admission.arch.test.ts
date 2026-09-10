// @vitest-inputs src/**/*.{ts,tsx}
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import {
  AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS,
  AUTHORED_WORKFLOW_LAUNCH_PERSISTENCE_SOURCES,
} from "./authored-launch-admission-callers";

const REPO_ROOT = path.resolve(__dirname, "../../..");

const CALLER_SOURCES = {
  "project-validate": "src/lib/workflow-graph/validate-route-handlers.ts",
  "global-template-validate":
    "src/lib/workflow-graph/validate-route-handlers.ts",
  "project-run": "src/lib/workflow-graph/execution-route-handlers.ts",
  ...Object.fromEntries(
    Object.entries(AUTHORED_WORKFLOW_LAUNCH_PERSISTENCE_SOURCES).flatMap(
      ([sourcePath, registration]) =>
        registration.admission === "active"
          ? registration.callers.map((caller) => [caller, sourcePath])
          : [],
    ),
  ),
  // The spec path deliberately splits the two roles this map elsewhere
  // collapses: candidate finalization ADMITS through the dep the composition
  // wires (service-factory), while delivery-plan-service only persists the
  // already-admitted result. The admission call is what this test locates.
  "spec-proposal": "src/lib/specs/service-factory.ts",
};

const ADMISSION_ADAPTERS = [
  "src/lib/workflow-graph/validate-route-handlers.ts",
  "src/lib/workflow-graph/template-library-route-handlers.ts",
  "src/lib/workflows/definition-route-handlers.ts",
  "src/lib/workflows/definition-edit-handler.ts",
  "src/lib/workflow-graph/execution-route-handlers.ts",
];

function read(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf-8");
}

function productionTypeScriptFiles(relativeDirectory: string): string[] {
  const directory = path.join(REPO_ROOT, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return productionTypeScriptFiles(relativePath);
    return entry.isFile() &&
      [".ts", ".tsx"].some((extension) => entry.name.endsWith(extension)) &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".test.tsx")
      ? [relativePath]
      : [];
  });
}

function workflowStorageMutationLines(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const factoryNames = new Set(["createWorkflowStorageService"]);
  const factoryNamespaces = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.moduleSpecifier.text.endsWith("/workflow-graph/storage")
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      factoryNamespaces.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (imported === "createWorkflowStorageService") {
          factoryNames.add(binding.name.text);
        }
      }
    }
  }

  const isFactoryCall = (expression: ts.Expression): boolean => {
    if (!ts.isCallExpression(expression)) return false;
    if (ts.isIdentifier(expression.expression)) {
      return factoryNames.has(expression.expression.text);
    }
    return (
      ts.isPropertyAccessExpression(expression.expression) &&
      ts.isIdentifier(expression.expression.expression) &&
      factoryNamespaces.has(expression.expression.expression.text) &&
      expression.expression.name.text === "createWorkflowStorageService"
    );
  };
  const containsFactoryCall = (node: ts.Node): boolean => {
    if (ts.isExpression(node) && isFactoryCall(node)) return true;
    return ts.forEachChild(node, containsFactoryCall) ?? false;
  };
  const receiverPaths = new Set<string>();
  const addTypedReceiver = (
    node:
      | ts.ParameterDeclaration
      | ts.PropertySignature
      | ts.PropertyDeclaration,
  ): void => {
    if (!node.name || !ts.isIdentifier(node.name) || !node.type) return;
    const typeName = node.type.getText(sourceFile);
    if (
      typeName !== "WorkflowDefinitionStoragePort" &&
      typeName !== "ExecutionWorkflowDefinitions"
    ) {
      return;
    }
    receiverPaths.add(node.name.text);
    receiverPaths.add(`deps.${node.name.text}`);
    receiverPaths.add(`this.${node.name.text}`);
  };
  const mutations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.initializer && containsFactoryCall(node.initializer)) {
        receiverPaths.add(node.name.text);
      }
    }
    if (
      ts.isParameter(node) ||
      ts.isPropertySignature(node) ||
      ts.isPropertyDeclaration(node)
    ) {
      addTypedReceiver(node);
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      (node.expression.name.text === "create" ||
        node.expression.name.text === "update")
    ) {
      const receiver = node.expression.expression;
      const receiverText = receiver.getText(sourceFile);
      const isStorageReceiver =
        receiverPaths.has(receiverText) || isFactoryCall(receiver);
      if (isStorageReceiver) {
        const line = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        ).line;
        mutations.push(sourceFile.text.split("\n")[line]!.trim());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mutations;
}

function deliveryPlanLaunchMutationLines(source: string): string[] {
  const sourceFile = ts.createSourceFile(
    "source.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const mutations: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText(sourceFile) === "deps.plans" &&
      ["open", "saveDraft", "propose"].includes(node.expression.name.text)
    ) {
      const line = sourceFile.getLineAndCharacterOfPosition(
        node.getStart(sourceFile),
      ).line;
      mutations.push(sourceFile.text.split("\n")[line]!.trim());
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return mutations;
}

function persistedLaunchMutationSources(): string[] {
  return productionTypeScriptFiles("src").filter((sourcePath) => {
    const source = read(sourcePath);
    const mayUseWorkflowStorage =
      source.includes("createWorkflowStorageService") ||
      source.includes("WorkflowDefinitionStoragePort") ||
      source.includes("ExecutionWorkflowDefinitions");
    const mayPersistDeliveryPlanLaunch = ["open", "saveDraft", "propose"].some(
      (method) => source.includes(`deps.plans.${method}(`),
    );
    if (!mayUseWorkflowStorage && !mayPersistDeliveryPlanLaunch) {
      return false;
    }
    return (
      (mayUseWorkflowStorage &&
        workflowStorageMutationLines(source).length > 0) ||
      (mayPersistDeliveryPlanLaunch &&
        deliveryPlanLaunchMutationLines(source).length > 0)
    );
  });
}

describe("authored-launch admission ownership", () => {
  it("declares every ordinary caller and reserves spec proposal for candidate finalization", () => {
    expect(Object.keys(AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS)).toEqual([
      "project-validate",
      "global-template-validate",
      "project-create",
      "project-replace",
      "project-edit",
      "project-run",
      "global-template-create",
      "global-template-replace",
      "global-template-edit",
      "spec-proposal",
    ]);
    expect(
      AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS["project-validate"],
    ).toEqual({
      documentScopes: ["project"],
      persists: false,
    });
    expect(
      AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS["global-template-validate"],
    ).toEqual({
      documentScopes: ["global"],
      persists: false,
    });
    expect(AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS["spec-proposal"]).toEqual(
      {
        documentScopes: ["project"],
        persists: true,
      },
    );
  });

  it("routes every ordinary registry caller through shared admission", () => {
    const ordinaryCallers = Object.entries(
      AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS,
    )
      .filter(([, registration]) => registration.persists)
      .map(([caller]) => caller)
      .concat(["project-validate", "global-template-validate", "project-run"])
      .sort();
    expect(Object.keys(CALLER_SOURCES).sort()).toEqual(ordinaryCallers);
    for (const [caller, sourcePath] of Object.entries(CALLER_SOURCES)) {
      const source = read(sourcePath);
      expect(source).toContain("admitAuthoredWorkflowLaunch");
      expect(source).toContain(`"${caller}"`);
    }
  });

  // The scan type-checks every production source under src/, which can exceed
  // the default timeout when the whole suite's worker pool contends for CPU.
  it(
    "declares every production draft persistence path before it can bypass admission",
    { timeout: 60_000 },
    () => {
      expect(persistedLaunchMutationSources().sort()).toEqual(
        Object.keys(AUTHORED_WORKFLOW_LAUNCH_PERSISTENCE_SOURCES).sort(),
      );
    },
  );

  it("recognizes a normalized launch passed directly to workflow storage", () => {
    const source = [
      'import { createWorkflowStorageService as makeStorage } from "@/lib/workflow-graph/storage";',
      "const storage =\n  makeStorage();",
      "storage.create(scope, validation.launch);",
    ].join("\n");
    expect(workflowStorageMutationLines(source)).toEqual([
      "storage.create(scope, validation.launch);",
    ]);
  });

  it("recognizes every delivery-plan draft write", () => {
    const source = [
      "deps.plans.open(openInput);",
      "deps.plans.saveDraft(editInput);",
      "deps.plans.propose(proposalInput);",
    ].join("\n");

    expect(deliveryPlanLaunchMutationLines(source)).toEqual([
      "deps.plans.open(openInput);",
      "deps.plans.saveDraft(editInput);",
      "deps.plans.propose(proposalInput);",
    ]);
  });

  it("keeps project-bound validation composition inside the admission service", () => {
    for (const sourcePath of ADMISSION_ADAPTERS) {
      const source = read(sourcePath);
      expect(source).not.toContain("validateWorkflowPlan(");
      expect(source).not.toContain("createValidationCommandPreflight(");
      expect(source).not.toContain("collectValidationCommandIssues(");
      expect(source).not.toContain("checkWorkflowDefaults(");
    }
  });
});
