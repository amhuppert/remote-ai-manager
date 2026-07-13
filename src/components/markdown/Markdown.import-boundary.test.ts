import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../..");
const MARKDOWN_ENTRY = path.resolve(__dirname, "Markdown.tsx");
const MARKDOWN_RENDERER = path.resolve(__dirname, "MarkdownRenderer.tsx");
const SOURCE_EXTENSIONS = [".ts", ".tsx"] as const;

function resolveProjectImport(
  fromFile: string,
  specifier: string,
): string | null {
  if (
    !specifier.startsWith("./") &&
    !specifier.startsWith("../") &&
    !specifier.startsWith("@/")
  ) {
    return null;
  }

  const baseDirectory = specifier.startsWith("@/")
    ? SRC_ROOT
    : path.dirname(fromFile);
  const relativeSpecifier = specifier.startsWith("@/")
    ? specifier.slice(2)
    : specifier;
  const candidate = path.resolve(baseDirectory, relativeSpecifier);

  for (const extension of SOURCE_EXTENSIONS) {
    const file = `${candidate}${extension}`;
    if (existsSync(file) && statSync(file).isFile()) return file;
  }

  for (const extension of SOURCE_EXTENSIONS) {
    const file = path.join(candidate, `index${extension}`);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }

  return null;
}

function parseSource(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function runtimeStaticSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  for (const statement of source.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const clause = statement.importClause;
      const onlyTypeSpecifiers =
        !clause?.name &&
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      if (!clause?.isTypeOnly && !onlyTypeSpecifiers) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }

    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      const onlyTypeSpecifiers =
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause) &&
        statement.exportClause.elements.length > 0 &&
        statement.exportClause.elements.every((element) => element.isTypeOnly);
      if (!statement.isTypeOnly && !onlyTypeSpecifiers) {
        specifiers.push(statement.moduleSpecifier.text);
      }
    }
  }

  return specifiers;
}

function dynamicImportSpecifiers(source: ts.SourceFile): string[] {
  const specifiers: string[] = [];

  function visit(node: ts.Node) {
    const [specifier] = ts.isCallExpression(node) ? node.arguments : [];
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      specifier &&
      ts.isStringLiteral(specifier)
    ) {
      specifiers.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specifiers;
}

function collectRuntimeStaticClosure(
  entry: string,
  seen = new Set<string>(),
): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);

  for (const specifier of runtimeStaticSpecifiers(parseSource(entry))) {
    const importedFile = resolveProjectImport(entry, specifier);
    if (importedFile) collectRuntimeStaticClosure(importedFile, seen);
  }

  return seen;
}

describe("canonical Markdown deferred import boundary", () => {
  it("keeps the renderer behind one dynamic path", () => {
    expect(collectRuntimeStaticClosure(MARKDOWN_ENTRY)).not.toContain(
      MARKDOWN_RENDERER,
    );

    const dynamicRoots = dynamicImportSpecifiers(parseSource(MARKDOWN_ENTRY))
      .map((specifier) => resolveProjectImport(MARKDOWN_ENTRY, specifier))
      .filter((file): file is string => file !== null);
    const rendererRoots = dynamicRoots.filter((root) =>
      collectRuntimeStaticClosure(root).has(MARKDOWN_RENDERER),
    );

    expect(rendererRoots).toHaveLength(1);
  });
});
