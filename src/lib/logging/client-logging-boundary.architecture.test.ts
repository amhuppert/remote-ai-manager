// @vitest-inputs src/**/*.{ts,tsx}
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "..", "..");
const MODULE_EXTENSIONS = [".ts", ".tsx"];
const NON_PRODUCTION_SOURCE = /\.(?:test|stories)\.[cm]?[jt]sx?$/;

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(filePath));
      continue;
    }
    if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      files.push(filePath);
    }
  }
  return files;
}

function isClientModule(source: string): boolean {
  return /^\s*["']use client["'];/m.test(source);
}

function runtimeImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const staticRe =
    /\b(?:import|export)\s+(type\s+)?([^;]*?)from\s+["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  const sideEffectRe = /(?:^|\n)\s*import\s+["']([^"']+)["']/g;

  for (const match of source.matchAll(staticRe)) {
    if (match[1] !== undefined) continue;
    const specifier = match[3];
    if (specifier !== undefined) specifiers.push(specifier);
  }
  for (const re of [dynamicRe, sideEffectRe]) {
    for (const match of source.matchAll(re)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function resolveProjectModule(
  specifier: string,
  fromFile: string,
  moduleFiles: ReadonlySet<string>,
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
  return candidates.find((candidate) => moduleFiles.has(candidate)) ?? null;
}

function relative(filePath: string): string {
  return path.relative(process.cwd(), filePath);
}

function asyncHooksClientChains(): string[] {
  const moduleFiles = listTypeScriptFiles(SRC_ROOT);
  const moduleFileSet = new Set(moduleFiles);
  const sourceFiles = moduleFiles.filter(
    (filePath) => !NON_PRODUCTION_SOURCE.test(path.basename(filePath)),
  );
  const textCache = new Map<string, string>();
  const textOf = (filePath: string): string => {
    const cached = textCache.get(filePath);
    if (cached !== undefined) return cached;
    const source = readFileSync(filePath, "utf8");
    textCache.set(filePath, source);
    return source;
  };
  const chainByOffender = new Map<string, string>();
  const clientFiles = sourceFiles.filter((filePath) =>
    isClientModule(textOf(filePath)),
  );
  const visited = new Set(clientFiles);
  const queue: Array<{ filePath: string; chain: string[] }> = clientFiles.map(
    (filePath) => ({ filePath, chain: [relative(filePath)] }),
  );

  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const current = queue[queueIndex];
    if (current === undefined) continue;
    for (const specifier of runtimeImportSpecifiers(textOf(current.filePath))) {
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
      const resolved = resolveProjectModule(
        specifier,
        current.filePath,
        moduleFileSet,
      );
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
