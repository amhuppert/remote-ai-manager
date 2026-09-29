import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

export type ValueGraph = ReadonlyMap<string, readonly string[]>;

/** Literal imports surviving TypeScript erasure, including deferred imports. */
export function valueImportSpecifiers(file: string, source: string): string[] {
  const emitted = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.Preserve,
    },
  }).outputText;
  return [
    ...new Set(
      ts
        .preProcessFile(emitted, true, true)
        .importedFiles.map((item) => item.fileName),
    ),
  ].sort();
}

export function resolveProjectImport(
  root: string,
  from: string,
  specifier: string,
): string | null {
  const base = specifier.startsWith("@/")
    ? `src/${specifier.slice(2)}`
    : specifier.startsWith(".")
      ? path.posix.normalize(
          path.posix.join(path.posix.dirname(from), specifier),
        )
      : null;
  if (base === null) return null;
  const withoutJs = base.replace(/\.(?:js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base,
    ...[base, withoutJs].flatMap((stem) =>
      [
        ".ts",
        ".tsx",
        ".mts",
        ".cts",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        "/index.ts",
        "/index.tsx",
        "/index.js",
      ].map((extension) => stem + extension),
    ),
  ];
  const found = candidates.find(
    (candidate) =>
      path.extname(candidate) !== "" && existsSync(path.join(root, candidate)),
  );
  if (found === undefined)
    throw new Error(`Unresolved project import: ${from} -> ${specifier}`);
  return found;
}

/** Reads only the closure of its roots; external packages are terminal. */
export function readValueGraph(
  root: string,
  entries: readonly string[],
): ValueGraph {
  const graph = new Map<string, string[]>();
  const pending = [...entries];
  while (pending.length) {
    const file = pending.pop();
    if (file === undefined || graph.has(file)) continue;
    const imports = /\.[cm]?[jt]sx?$/.test(file)
      ? valueImportSpecifiers(file, readFileSync(path.join(root, file), "utf8"))
      : [];
    const dependencies = [
      ...new Set(
        imports.flatMap((specifier) => {
          const resolved = resolveProjectImport(root, file, specifier);
          return resolved === null ? [] : [resolved];
        }),
      ),
    ].sort();
    graph.set(file, dependencies);
    pending.push(...dependencies);
  }
  return graph;
}

export function shortestImportPath(
  graph: ValueGraph,
  from: string,
  to: string,
): string[] | null {
  const queue = [[from]];
  const seen = new Set([from]);
  for (const chain of queue) {
    const tail = chain.at(-1);
    if (tail === undefined) continue;
    if (tail === to) return chain;
    for (const dependency of graph.get(tail) ?? []) {
      if (seen.has(dependency)) continue;
      seen.add(dependency);
      queue.push([...chain, dependency]);
    }
  }
  return null;
}
