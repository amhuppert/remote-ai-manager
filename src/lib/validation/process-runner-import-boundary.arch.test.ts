import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const VALIDATION_ROOT = path.join(SRC_ROOT, "lib", "validation");

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const filePath = path.join(dir, entry);
    if (statSync(filePath).isDirectory()) {
      files.push(...listSourceFiles(filePath));
      continue;
    }
    if (/\.(?:[cm]?ts|tsx)$/.test(entry)) files.push(filePath);
  }
  return files;
}

function isInside(dir: string, filePath: string): boolean {
  const relative = path.relative(dir, filePath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function sourceRootFor(filePath: string): string {
  const marker = `${path.sep}src${path.sep}`;
  const markerIndex = filePath.lastIndexOf(marker);
  if (markerIndex < 0) return SRC_ROOT;
  return filePath.slice(0, markerIndex + marker.length - 1);
}

function withoutModuleExtension(filePath: string): string {
  return filePath.replace(/\.(?:[cm]?[jt]sx?)$/, "");
}

function resolvesToProcessRunner(specifier: string, filePath: string): boolean {
  const srcRoot = sourceRootFor(filePath);
  let resolved: string;
  if (specifier.startsWith("@/")) {
    resolved = path.join(srcRoot, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    resolved = path.resolve(path.dirname(filePath), specifier);
  } else if (path.isAbsolute(specifier)) {
    resolved = specifier;
  } else {
    return false;
  }
  return (
    withoutModuleExtension(resolved) ===
    path.join(srcRoot, "lib", "validation", "process-runner")
  );
}

function findProcessRunnerImports(source: string, filePath: string): string[] {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const offenders: string[] = [];

  function recordSpecifier(node: ts.StringLiteralLike): void {
    if (!resolvesToProcessRunner(node.text, filePath)) return;
    const line =
      sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    offenders.push(`${filePath}:${line} imports ${node.text}`);
  }

  function visit(node: ts.Node): void {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      recordSpecifier(node.moduleSpecifier);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length > 0 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      const specifier = node.arguments[0];
      if (specifier && ts.isStringLiteralLike(specifier)) {
        recordSpecifier(specifier);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return offenders;
}

describe("validation process-runner import boundary", () => {
  it("detects a forbidden alias import outside src/lib/validation", () => {
    expect(
      findProcessRunnerImports(
        'import { spawnValidation } from "@/lib/validation/process-runner";',
        "/repo/src/lib/workflows/merge/actors.ts",
      ),
    ).toEqual([
      "/repo/src/lib/workflows/merge/actors.ts:1 imports @/lib/validation/process-runner",
    ]);
  });

  it("detects relative, dynamic, and require imports", () => {
    const source = [
      'export type { SpawnValidationParams } from "../../validation/process-runner";',
      'const runner = import("../../validation/process-runner.js");',
      'const fallback = require("../../validation/process-runner");',
    ].join("\n");

    expect(
      findProcessRunnerImports(
        source,
        "/repo/src/lib/workflows/merge/actors.ts",
      ),
    ).toHaveLength(3);
  });

  it("allows imports only from modules inside src/lib/validation", () => {
    const offenders: string[] = [];
    for (const filePath of listSourceFiles(SRC_ROOT)) {
      if (isInside(VALIDATION_ROOT, filePath)) continue;
      const source = readFileSync(filePath, "utf8");
      if (!source.includes("process-runner")) continue;
      offenders.push(...findProcessRunnerImports(source, filePath));
    }

    expect(
      offenders,
      `Only src/lib/validation may import its low-level process runner:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
