// @vitest-inputs src/** package.json
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  readValueGraph,
  resolveProjectImport,
} from "../../../scripts/module-imports";

const repoRoot = path.resolve(__dirname, "../../..");

function sourceFile(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(path.join(repoRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

describe("persisted graph boundary projection", () => {
  it("constructs boundary events without acquiring event delivery capabilities", () => {
    const setters = "src/lib/state-store/setters.ts";
    const declaration = sourceFile(setters).statements.find(
      (node) =>
        ts.isImportDeclaration(node) &&
        node.importClause?.namedBindings !== undefined &&
        ts.isNamedImports(node.importClause.namedBindings) &&
        node.importClause.namedBindings.elements.some(
          (element) =>
            (element.propertyName ?? element.name).text ===
            "createGraphWorkflowBoundaryEvent",
        ),
    );
    if (
      declaration === undefined ||
      !ts.isImportDeclaration(declaration) ||
      !ts.isStringLiteral(declaration.moduleSpecifier)
    ) {
      throw new Error(
        "The persistence boundary must import its graph event projector",
      );
    }
    const entry = resolveProjectImport(
      repoRoot,
      setters,
      declaration.moduleSpecifier.text,
    );
    if (entry === null)
      throw new Error("The graph event projector must be local");
    const graph = readValueGraph(repoRoot, [entry]);
    const forbidden = [...graph.keys()].filter(
      (file) =>
        file === "src/lib/workflow-graph/execution-events.ts" ||
        /^src\/lib\/(events|notifications|push-notification)\//.test(file),
    );
    expect(
      forbidden,
      "Persistence may project event data, but must not import its delivery path",
    ).toEqual([]);
  });
});
