// @vitest-inputs src/lib/sessions/optimistic.ts src/lib/tickets/schemas.ts src/lib/commands/schemas.ts src/lib/agent-backends/errors.ts src/lib/agent-backends/execution-schemas.ts src/lib/workflows/primitives/agent-call-vocabulary.ts
// @vitest-inputs src/** package.json
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractImportStatements } from "./seam-adoption";
import { readValueGraph, shortestImportPath } from "./module-imports";
import { CORE_BOUNDARIES, coreBoundaryViolations } from "./module-seams";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function valueImports(file: string): string[] {
  return extractImportStatements(
    readFileSync(path.join(repoRoot, file), "utf8"),
  )
    .filter((statement) => !statement.typeOnly)
    .map(({ specifier }) =>
      specifier.startsWith("@/")
        ? `src/${specifier.slice(2)}`
        : path.posix.normalize(
            path.posix.join(path.posix.dirname(file), specifier),
          ),
    );
}

describe("reviewed module boundaries", () => {
  it("keeps ticket storage bindings independent of execution composition", () => {
    const roots = ["src/lib/tickets/storage-production.ts"];
    expect(coreBoundaryViolations(readValueGraph(repoRoot, roots))).toEqual([]);
  }, 30000);
  it("keeps context-artifact storage independent of compaction and non-HTTP consumers independent of routes", () => {
    const roots = CORE_BOUNDARIES.flatMap((rule) => rule.roots).filter(
      (root) =>
        root.startsWith("src/lib/context-artifacts/") ||
        root === "src/lib/tickets/service-factory.ts" ||
        root === "src/lib/conversation-core/production-turn-dependencies.ts" ||
        root === "src/lib/conversations/naming-context.ts",
    );
    expect(coreBoundaryViolations(readValueGraph(repoRoot, roots))).toEqual([]);
  }, 30000);
  it("keeps the conversation executor and runtime binding independent of production composition", () => {
    const cores = [
      "src/lib/conversation-core/executor.ts",
      "src/lib/conversation-core/turn/runtime-binding.ts",
    ];
    const compositions = [
      "src/lib/supervision/production.ts",
      "src/lib/conversation-core/production-turn-dependencies.ts",
      "src/lib/prompt/sdk-driver.ts",
    ];
    const graph = readValueGraph(repoRoot, cores);
    const paths = cores.flatMap((core) =>
      compositions.flatMap((composition) => {
        const chain = shortestImportPath(graph, core, composition);
        return chain === null ? [] : [chain];
      }),
    );
    expect(paths).toEqual([]);
  }, 30000);
  it("keeps optimistic orchestration independent of production services", () => {
    const productionServices = new Set([
      "src/lib/prompt/sdk-driver",
      "src/lib/jobs/queue",
      "src/lib/notifications/service",
      "src/lib/workflows/merge/initiation",
      "src/lib/sessions/optimistic-production",
    ]);
    expect(
      valueImports("src/lib/sessions/optimistic.ts").filter((dependency) =>
        productionServices.has(dependency),
      ),
    ).toEqual([]);
  });

  it("keeps admission policy out of shared execution vocabulary consumers", () => {
    const contracts = [
      "src/lib/tickets/schemas.ts",
      "src/lib/commands/schemas.ts",
      "src/lib/agent-backends/errors.ts",
      "src/lib/agent-backends/execution-schemas.ts",
      "src/lib/workflows/primitives/agent-call-vocabulary.ts",
    ];
    expect(
      contracts.filter((file) =>
        valueImports(file).includes(
          "src/lib/agent-backends/execution-admission",
        ),
      ),
    ).toEqual([]);
  });
});
