import { describe, expect, it } from "vitest";
import {
  crossDomainCycleEdges,
  cruiseValueGraph,
  estimateAffectedTests,
  reachableFiles,
  reverseGraph,
  stronglyConnectedComponents,
} from "./module-graph-analysis";
import type { ValueGraph } from "./module-imports";

const a = "src/lib/alpha/a.ts";
const b = "src/lib/beta/b.ts";
const c = "src/lib/alpha/c.ts";

describe("file-level module graph analysis", () => {
  it("keeps value, dynamic and require edges while excluding erased types and external nodes", () => {
    const graph = cruiseValueGraph([
      {
        source: a,
        dependencies: [
          { resolved: b, preCompilationOnly: true },
          { resolved: c, dynamic: true },
          {
            resolved: "src/lib/gamma/required.ts",
            dependencyTypes: ["require"],
          },
          { resolved: "fs" },
          { resolved: "node_modules/pkg/index.js" },
          { resolved: "unresolved-package" },
        ],
      },
      { source: b, dependencies: [] },
      { source: c, dependencies: [] },
      { source: "src/lib/gamma/required.ts", dependencies: [] },
      { source: "fs", coreModule: true, dependencies: [] },
      {
        source: "node_modules/pkg/index.js",
        matchesDoNotFollow: true,
        dependencies: [],
      },
      { source: "unresolved-package", couldNotResolve: true, dependencies: [] },
    ]);
    expect([...graph.keys()]).toEqual(
      [a, c, b, "src/lib/gamma/required.ts"].sort(),
    );
    expect(graph.get(a)).toEqual([c, "src/lib/gamma/required.ts"]);
  });

  it("finds disjoint components including terminal targets and isolated files", () => {
    const graph: ValueGraph = new Map([
      ["z.ts", []],
      [a, [b]],
      [b, [a, "terminal.ts"]],
      [c, [c]],
    ]);
    expect(stronglyConnectedComponents(graph)).toEqual([
      [a, b],
      [c],
      ["terminal.ts"],
      ["z.ts"],
    ]);
  });

  it("reports every participating edge with a closed concrete witness", () => {
    const graph: ValueGraph = new Map([
      [a, [b, c]],
      [b, [c]],
      [c, [a]],
    ]);
    expect(crossDomainCycleEdges(graph)).toEqual([
      { from: a, to: c, witness: [a, c, a] },
      { from: a, to: b, witness: [a, b, c, a] },
      { from: c, to: a, witness: [c, a, c] },
      { from: b, to: c, witness: [b, c, a, b] },
    ]);
    // A new edge inside an existing component still needs a new allowance.
    const withExtraEdge = new Map(graph);
    withExtraEdge.set(b, [a, c]);
    expect(crossDomainCycleEdges(withExtraEdge)).toContainEqual({
      from: b,
      to: a,
      witness: [b, a, b],
    });
  });

  it("includes non-domain bridges but excludes one-domain cycles and acyclic folder summaries", () => {
    const bridge = "src/components/Bridge.ts";
    const graph: ValueGraph = new Map([
      [a, [bridge]],
      [bridge, [b]],
      [b, [a]],
      [c, [c]],
      ["src/lib/alpha/x.ts", ["src/lib/beta/y.ts"]],
      ["src/lib/beta/z.ts", ["src/lib/alpha/w.ts"]],
    ]);
    expect(
      crossDomainCycleEdges(graph).map(({ from, to }) => [from, to]),
    ).toEqual([
      [bridge, b],
      [a, bridge],
      [b, a],
    ]);
  });

  it("computes forward and reverse reach without duplicate paths or infinite cycles", () => {
    const graph: ValueGraph = new Map([
      [a, [b, c]],
      [b, [a]],
      [c, []],
    ]);
    expect(reachableFiles(graph, [a, a])).toEqual([a, c, b]);
    expect(reachableFiles(reverseGraph(graph), [c])).toEqual([a, c, b]);
    expect(reachableFiles(graph, ["deleted.ts"])).toEqual(["deleted.ts"]);
    expect(reachableFiles(reverseGraph(new Map([[a, [b]]])), [b])).toEqual([
      a,
      b,
    ]);
  });

  it("handles a deep acyclic import chain without a recursive call-stack limit", () => {
    const graph = new Map<string, string[]>();
    for (let index = 0; index < 12000; index += 1) {
      graph.set(`node-${index}`, index === 11999 ? [] : [`node-${index + 1}`]);
    }
    expect(stronglyConnectedComponents(graph)).toHaveLength(12000);
  });

  it("unions value reach and declared inputs, including missing paths and directly changed tests", () => {
    const graph: ValueGraph = new Map([
      ["unit.test.ts", [a]],
      [a, [b]],
      [b, []],
      ["both.test.ts", [b]],
      ["scanner.test.ts", []],
    ]);
    expect(
      estimateAffectedTests({
        graph,
        testFiles: [
          "unit.test.ts",
          "both.test.ts",
          "scanner.test.ts",
          "new.test.ts",
        ],
        changedPaths: [b, "src/app/deleted/route.ts", "new.test.ts"],
        declaredInputsByTestFile: {
          "both.test.ts": ["src/lib/**"],
          "scanner.test.ts": ["src/app/**"],
          "excluded.test.ts": ["src/**"],
        },
      }),
    ).toEqual({
      importSelected: ["both.test.ts", "new.test.ts", "unit.test.ts"],
      declaredInputSelected: ["both.test.ts", "scanner.test.ts"],
      selected: [
        "both.test.ts",
        "new.test.ts",
        "scanner.test.ts",
        "unit.test.ts",
      ],
    });
  });
});
