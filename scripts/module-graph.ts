#!/usr/bin/env bun
/**
 * Saves the file-level production graph, with type-only edges marked, and
 * renders a src/lib domain overview. Collapsing files into domains can create
 * cycles that do not exist between files; use the JSON for boundary analysis.
 *
 * The cruise starts at the modules production loads, so a module only tests or
 * `scripts/` import stays out of the graph. Graphviz runs as WebAssembly
 * (`@viz-js/viz`), so no system install is needed.
 *
 * --tests also saves a test/fixture graph and declared non-import test inputs.
 * These are static reachability inputs, not measured module evaluation or the
 * registered test runner's selection. --no-render skips the SVG overview.
 *
 * --report writes file-level analysis; --from/--to query import paths and
 * reachability. --tests --changed <path> estimates affected tests.
 * See docs/module-graph.md for provenance and examples.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { instance } from "@viz-js/viz";
import { cruise, format, type ICruiseResult } from "dependency-cruiser";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";
import { buildRepositoryTestProfileInventory } from "./test-profiles";
import {
  crossDomainCycleEdges,
  cruiseValueGraph,
  estimateAffectedTests,
  reachableFiles,
  reverseGraph,
  stronglyConnectedComponents,
} from "./module-graph-analysis";
import { shortestImportPath, type ValueGraph } from "./module-imports";
import { PRODUCTION_ENTRIES } from "./module-graph-roots";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const outputDir = path.join(repoRoot, ".cc/temp/module-graph");

// Replaces the default theme: its hollow type-only arrowhead is misleading
// once collapsing merges a domain's type and value imports into one edge.
const THEME = {
  replace: true,
  graph: {
    rankdir: "LR",
    splines: "true",
    overlap: "false",
    nodesep: "0.2",
    ranksep: "0.8",
    fontname: "Helvetica",
    fontsize: "10",
  },
  node: {
    shape: "box",
    style: "rounded, filled",
    fillcolor: "#ffffcc",
    fontname: "Helvetica",
    fontsize: "10",
  },
  edge: { arrowsize: "0.6", penwidth: "1.2", color: "#00000033" },
  modules: [],
  dependencies: [
    { criteria: { circular: true }, attributes: { color: "#d62728aa" } },
  ],
};

async function cruiseFiles(
  entries: readonly string[],
  includeTests: boolean,
): Promise<ICruiseResult> {
  const tsConfigFile = path.join(repoRoot, "tsconfig.json");
  const { output } = await cruise(
    [...entries],
    {
      baseDir: repoRoot,
      tsConfig: { fileName: tsConfigFile },
      tsPreCompilationDeps: "specify",
      doNotFollow: { path: "node_modules" },
      exclude: {
        path: includeTests
          ? "\\.stories\\.[cm]?[jt]sx?$"
          : "\\.(test|stories)\\.[cm]?[jt]sx?$",
      },
      reporterOptions: { dot: { theme: THEME } },
    },
    {},
    { tsConfig: extractTSConfig(tsConfigFile) },
  );
  if (typeof output === "string") {
    throw new Error(
      "dependency-cruiser returned a report, not a cruise result",
    );
  }
  return output;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      tests: { type: "boolean", default: false },
      "no-render": { type: "boolean", default: false },
      report: { type: "boolean", default: false },
      from: { type: "string" },
      to: { type: "string" },
      changed: { type: "string", multiple: true },
    },
  });
  if (values.changed?.length && !values.tests) {
    throw new Error(
      "--changed requires --tests so the estimate includes the test inventory.",
    );
  }
  mkdirSync(outputDir, { recursive: true });
  const saveJson = (name: string, value: unknown): void => {
    const destination = path.join(outputDir, name);
    writeFileSync(destination, JSON.stringify(value, null, 2) + "\n");
    console.log(`Wrote ${path.relative(repoRoot, destination)}`);
  };
  const result = await cruiseFiles(PRODUCTION_ENTRIES, false);
  saveJson("production.json", result);
  let validation: ICruiseResult | undefined;
  let inventory:
    | ReturnType<typeof buildRepositoryTestProfileInventory>
    | undefined;
  if (values.tests) {
    inventory = buildRepositoryTestProfileInventory(repoRoot);
    validation = await cruiseFiles(
      [
        ...PRODUCTION_ENTRIES,
        ...inventory.unitTestFiles,
        "vitest.node.setup.ts",
        "vitest.jsdom.setup.ts",
        "vitest.architecture.setup.ts",
      ],
      true,
    );
    saveJson("validation.json", validation);
    saveJson("test-inputs.json", {
      byProfile: inventory.byProfile,
      declaredInputsByTestFile: inventory.declaredInputsByTestFile,
    });
  }
  if (values.report || values.tests || values.from || values.to) {
    const productionInventory = cruiseValueGraph(result.modules);
    const productionRoots = [...productionInventory.keys()].filter((file) =>
      PRODUCTION_ENTRIES.some(
        (entry) => file === entry || file.startsWith(`${entry}/`),
      ),
    );
    const reachable = new Set(
      reachableFiles(productionInventory, productionRoots),
    );
    const productionGraph = new Map(
      [...productionInventory].filter(([file]) => reachable.has(file)),
    );
    const queryGraph =
      validation === undefined
        ? productionGraph
        : cruiseValueGraph(validation.modules);
    for (const file of [values.from, values.to]) {
      if (file !== undefined && !queryGraph.has(file)) {
        throw new Error(
          `No module ${file} in the selected graph. Use an exact repository-relative file path; --tests includes test files.`,
        );
      }
    }
    const changedPaths = [
      ...new Set(values.changed ?? (values.from ? [values.from] : [])),
    ].sort();
    const testImpact =
      inventory === undefined
        ? null
        : {
            unitTestFiles: inventory.unitTestFiles.length,
            changedPaths,
            estimate:
              changedPaths.length === 0
                ? null
                : estimateAffectedTests({
                    graph: queryGraph,
                    testFiles: inventory.unitTestFiles,
                    changedPaths,
                    declaredInputsByTestFile:
                      inventory.declaredInputsByTestFile,
                  }),
            hint:
              changedPaths.length === 0
                ? "Supply --changed <path> (repeatable) or --from <path> for an affected-test estimate."
                : null,
            limitation:
              "Static value reach plus declared inputs; setup/configuration-driven full-scope expansion and runtime selection are not simulated.",
          };
    saveJson("report.json", {
      provenance: {
        generatedAt: new Date().toISOString(),
        source: "dependency-cruiser with tsPreCompilationDeps=specify",
        membership:
          "Production value reach starts at actual application entries; raw production.json also preserves modules reached only by type imports.",
        edgeFilter:
          "Internal resolved modules, excluding preCompilationOnly edges; dynamic imports and require edges remain.",
        evaluation:
          "Static reachability is not observed module evaluation. TypeScript/Vite may erase value-spelled imports used only as types; seams uses a separate TypeScript-erased scanner.",
        timing:
          "Raw JSON retains dynamic, moduleSystem, dependencyTypes and preCompilationOnly. Static import syntax is eager; require call timing is unknown and dynamic imports are deferred syntax, not observed execution.",
        rawArtifacts: values.tests
          ? ["production.json", "validation.json", "test-inputs.json"]
          : ["production.json"],
        productionRoots,
      },
      production: {
        typeInclusiveInternalFiles: productionInventory.size,
        ...summarizeGraph(productionGraph),
        syntax: summarizeSyntax(result),
        crossDomainCycleEdges: crossDomainCycleEdges(productionGraph),
      },
      query: {
        graph: values.tests ? "validation-value" : "production-value",
        from: values.from ? reachSummary(queryGraph, values.from) : null,
        to: values.to ? reachSummary(queryGraph, values.to) : null,
        shortestPath:
          values.from && values.to
            ? shortestImportPath(queryGraph, values.from, values.to)
            : null,
      },
      testImpact,
    });
  }
  if (values["no-render"]) return;
  const { output: dot } = await format(result, {
    outputType: "dot",
    includeOnly: "^src/lib/",
    collapse: "^src/lib/[^/]+",
  });
  if (typeof dot !== "string") {
    throw new Error("dependency-cruiser returned a cruise result, not DOT");
  }
  const svg = (await instance()).renderString(dot, { format: "svg" });

  const dotPath = path.join(outputDir, "src-lib-domains.dot");
  const svgPath = path.join(outputDir, "src-lib-domains.svg");
  writeFileSync(dotPath, dot);
  writeFileSync(svgPath, svg);
  console.log(`Wrote ${path.relative(repoRoot, svgPath)}`);
  console.log(`Wrote ${path.relative(repoRoot, dotPath)}`);
}

function reachSummary(graph: ValueGraph, file: string) {
  const forward = reachableFiles(graph, [file]);
  const reverse = reachableFiles(reverseGraph(graph), [file]);
  return {
    file,
    includesQueryFile: true,
    forwardCount: forward.length,
    reverseCount: reverse.length,
    forward,
    reverse,
  };
}

function summarizeGraph(graph: ValueGraph) {
  const components = stronglyConnectedComponents(graph);
  const cycles = components
    .filter(
      (members) =>
        members.length > 1 ||
        members.some((file) => graph.get(file)?.includes(file)),
    )
    .map((members) => {
      const from = members[0];
      if (from === undefined)
        throw new Error("Empty strongly connected component");
      const set = new Set(members);
      const to = graph.get(from)?.find((file) => set.has(file));
      if (to === undefined) throw new Error(`No cycle edge from ${from}`);
      const back = shortestImportPath(graph, to, from);
      if (back === null) throw new Error(`No cycle return path to ${from}`);
      return { members, witness: [from, ...back] };
    });
  return {
    files: graph.size,
    edges: [...graph.values()].reduce(
      (total, dependencies) => total + dependencies.length,
      0,
    ),
    cyclicComponents: cycles.length,
    largestCyclicComponent: Math.max(
      0,
      ...cycles.map(({ members }) => members.length),
    ),
    cycles,
  };
}

function summarizeSyntax(result: ICruiseResult) {
  let typeOnly = 0;
  let staticImport = 0;
  let dynamicImport = 0;
  let requireTimingUnknown = 0;
  let otherValue = 0;
  const unresolved: Array<{ from: string; specifier: string }> = [];
  for (const sourceModule of result.modules) {
    for (const edge of sourceModule.dependencies) {
      if (edge.couldNotResolve)
        unresolved.push({ from: sourceModule.source, specifier: edge.module });
      if (edge.preCompilationOnly) typeOnly += 1;
      else if (edge.dynamic) dynamicImport += 1;
      else if (edge.dependencyTypes.includes("require"))
        requireTimingUnknown += 1;
      else if (edge.dependencyTypes.includes("import")) staticImport += 1;
      else otherValue += 1;
    }
  }
  return {
    scope: "All raw dependency records, including external edges",
    typeOnly,
    staticImport,
    dynamicImport,
    requireTimingUnknown,
    otherValue,
    unresolved,
  };
}

await main();
