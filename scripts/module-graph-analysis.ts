import { shortestImportPath, type ValueGraph } from "./module-imports";
import { selectTestsForChangedPaths } from "./test-inputs";

export interface CycleEdge {
  from: string;
  to: string;
  witness: string[];
}

export interface CruiseModule {
  source: string;
  coreModule?: boolean;
  couldNotResolve?: boolean;
  matchesDoNotFollow?: boolean;
  dependencies: readonly {
    resolved: string;
    preCompilationOnly?: boolean;
    dynamic?: boolean;
    dependencyTypes?: readonly string[];
  }[];
}

export function cruiseValueGraph(modules: readonly CruiseModule[]): ValueGraph {
  const internal = modules.filter(
    (module) =>
      !module.coreModule &&
      !module.couldNotResolve &&
      !module.matchesDoNotFollow,
  );
  const known = new Set(internal.map(({ source }) => source));
  return new Map(
    internal
      .sort((left, right) => left.source.localeCompare(right.source))
      .map((module) => [
        module.source,
        [
          ...new Set(
            module.dependencies
              .filter(
                (edge) => !edge.preCompilationOnly && known.has(edge.resolved),
              )
              .map(({ resolved }) => resolved),
          ),
        ].sort(),
      ]),
  );
}

export function reverseGraph(graph: ValueGraph): ValueGraph {
  const reverse = new Map<string, Set<string>>();
  for (const [from, dependencies] of graph) {
    if (!reverse.has(from)) reverse.set(from, new Set());
    for (const to of dependencies) {
      const dependents = reverse.get(to) ?? new Set<string>();
      dependents.add(from);
      reverse.set(to, dependents);
    }
  }
  return new Map(
    [...reverse]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([file, dependents]) => [file, [...dependents].sort()]),
  );
}

/** Includes the supplied roots, including changed paths absent from the graph. */
export function reachableFiles(
  graph: ValueGraph,
  roots: readonly string[],
): string[] {
  const seen = new Set<string>();
  const pending = [...roots];
  while (pending.length) {
    const file = pending.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    pending.push(...(graph.get(file) ?? []));
  }
  return [...seen].sort();
}

/** Iterative Kosaraju traversal also handles chains longer than the JS stack. */
export function stronglyConnectedComponents(graph: ValueGraph): string[][] {
  const reverse = reverseGraph(graph);
  const visited = new Set<string>();
  const postorder: string[] = [];
  for (const root of reverse.keys()) {
    const stack: Array<{ file: string; complete: boolean }> = [
      { file: root, complete: false },
    ];
    while (stack.length) {
      const entry = stack.pop();
      if (entry === undefined) continue;
      if (entry.complete) {
        postorder.push(entry.file);
        continue;
      }
      if (visited.has(entry.file)) continue;
      visited.add(entry.file);
      stack.push({ file: entry.file, complete: true });
      for (const dependency of graph.get(entry.file) ?? []) {
        if (!visited.has(dependency))
          stack.push({ file: dependency, complete: false });
      }
    }
  }
  visited.clear();
  const components: string[][] = [];
  for (const root of postorder.reverse()) {
    if (visited.has(root)) continue;
    const component: string[] = [];
    const pending = [root];
    while (pending.length) {
      const file = pending.pop();
      if (file === undefined || visited.has(file)) continue;
      visited.add(file);
      component.push(file);
      pending.push(...(reverse.get(file) ?? []));
    }
    components.push(component.sort());
  }
  return components.sort((left, right) =>
    left.join("\0").localeCompare(right.join("\0")),
  );
}

/** Every edge within a component spanning multiple src/lib domains is covered. */
export function crossDomainCycleEdges(graph: ValueGraph): CycleEdge[] {
  const edges: CycleEdge[] = [];
  for (const component of stronglyConnectedComponents(graph)) {
    const domains = new Set(
      component.flatMap((file) => {
        const domain = /^src\/lib\/([^/]+)\//.exec(file)?.[1];
        return domain === undefined ? [] : [domain];
      }),
    );
    if (domains.size < 2) continue;
    const members = new Set(component);
    const internal = new Map(
      component.map((from) => [
        from,
        [...new Set(graph.get(from) ?? [])]
          .filter((to) => members.has(to))
          .sort(),
      ]),
    );
    for (const [from, dependencies] of internal) {
      for (const to of dependencies) {
        const returnPath = shortestImportPath(internal, to, from);
        if (returnPath === null)
          throw new Error(`SCC has no return path: ${from} -> ${to}`);
        edges.push({ from, to, witness: [from, ...returnPath] });
      }
    }
  }
  return edges.sort(
    (left, right) =>
      left.from.localeCompare(right.from) || left.to.localeCompare(right.to),
  );
}

export function estimateAffectedTests(input: {
  graph: ValueGraph;
  testFiles: readonly string[];
  changedPaths: readonly string[];
  declaredInputsByTestFile: Readonly<Record<string, readonly string[]>>;
}): {
  importSelected: string[];
  declaredInputSelected: string[];
  selected: string[];
} {
  const tests = new Set(input.testFiles);
  const importSelected = reachableFiles(
    reverseGraph(input.graph),
    input.changedPaths,
  ).filter((file) => tests.has(file));
  const declaredInputSelected = selectTestsForChangedPaths(
    input.declaredInputsByTestFile,
    input.changedPaths,
  ).filter((file) => tests.has(file));
  return {
    importSelected,
    declaredInputSelected,
    selected: [
      ...new Set([...importSelected, ...declaredInputSelected]),
    ].sort(),
  };
}
