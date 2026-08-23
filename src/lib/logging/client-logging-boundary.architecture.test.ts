import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_EXTENSIONS = [".ts", ".tsx"];
const NON_PRODUCTION_SOURCE = /\.(?:test|stories)\.[cm]?[jt]sx?$/;

function listSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const filePath = path.join(directory, entry);
    if (statSync(filePath).isDirectory()) {
      files.push(...listSourceFiles(filePath));
      continue;
    }
    if (/\.(?:ts|tsx)$/.test(entry) && !NON_PRODUCTION_SOURCE.test(entry)) {
      files.push(filePath);
    }
  }
  return files;
}

function isClientModule(source: string): boolean {
  return /^\s*["']use client["'];/m.test(source);
}

function runtimeImportSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      if (
        !node.importClause?.isTypeOnly &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (ts.isExportDeclaration(node)) {
      if (
        !node.isTypeOnly &&
        node.moduleSpecifier &&
        ts.isStringLiteralLike(node.moduleSpecifier)
      ) {
        specifiers.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) {
        specifiers.push(specifier.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function resolveProjectModule(
  specifier: string,
  fromFile: string,
): string | null {
  const base = specifier.startsWith("@/")
    ? path.join(SRC_ROOT, specifier.slice(2))
    : specifier.startsWith(".")
      ? path.resolve(path.dirname(fromFile), specifier)
      : null;
  if (base === null) return null;

  const withoutExtension = base.replace(/\.[cm]?[jt]sx?$/, "");
  const candidates = [
    ...MODULE_EXTENSIONS.map((extension) => `${withoutExtension}${extension}`),
    ...MODULE_EXTENSIONS.map((extension) =>
      path.join(withoutExtension, `index${extension}`),
    ),
  ];
  return (
    candidates.find((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    }) ?? null
  );
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}

function asyncHooksClientChains(): string[] {
  const sourceFiles = listSourceFiles(SRC_ROOT);
  const textCache = new Map<string, string>();
  const textOf = (filePath: string): string => {
    const cached = textCache.get(filePath);
    if (cached !== undefined) return cached;
    const source = readFileSync(filePath, "utf8");
    textCache.set(filePath, source);
    return source;
  };
  const sourceCache = new Map<string, ts.SourceFile>();
  const sourceOf = (filePath: string): ts.SourceFile => {
    const cached = sourceCache.get(filePath);
    if (cached !== undefined) return cached;
    const parsed = ts.createSourceFile(
      filePath,
      textOf(filePath),
      ts.ScriptTarget.Latest,
      true,
    );
    sourceCache.set(filePath, parsed);
    return parsed;
  };
  const chainByOffender = new Map<string, string>();
  const clientFiles = sourceFiles.filter((filePath) =>
    isClientModule(textOf(filePath)),
  );
  const visited = new Set(clientFiles);
  const queue: Array<{ filePath: string; chain: string[] }> = clientFiles.map(
    (filePath) => ({ filePath, chain: [relative(filePath)] }),
  );

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const specifier of runtimeImportSpecifiers(
      sourceOf(current.filePath),
    )) {
      if (specifier === "node:async_hooks") {
        const offender = `${relative(current.filePath)} imports ${specifier}`;
        if (!chainByOffender.has(offender)) {
          chainByOffender.set(
            offender,
            [...current.chain, specifier].join("\n    -> "),
          );
        }
        continue;
      }
      const resolved = resolveProjectModule(specifier, current.filePath);
      if (resolved === null || visited.has(resolved)) continue;
      visited.add(resolved);
      queue.push({
        filePath: resolved,
        chain: [...current.chain, relative(resolved)],
      });
    }
  }

  return [...chainByOffender.values()].toSorted();
}

describe("client logging import boundary", () => {
  it("keeps AsyncLocalStorage out of client dependency graphs", () => {
    expect(asyncHooksClientChains()).toEqual([]);
  });
});
