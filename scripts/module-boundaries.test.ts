// @vitest-inputs src/lib/sessions/optimistic.ts src/lib/tickets/schemas.ts src/lib/commands/schemas.ts src/lib/agent-backends/errors.ts src/lib/agent-backends/execution-schemas.ts src/lib/workflows/primitives/agent-call-vocabulary.ts
// @vitest-inputs src/** package.json
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractImportStatements } from "./seam-adoption";
import { readValueGraph, shortestImportPath } from "./module-imports";

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
  it("keeps the conversation core and lifecycle fixture independent of production composition", () => {
    const cores = [
      "src/lib/workflows/conversation/manager.ts",
      "src/lib/workflows/conversation/testing/lifecycle-fixture.ts",
    ];
    const compositions = [
      "src/lib/workflows/conversation/lifecycle.ts",
      "src/lib/workflows/conversation/production.ts",
      "src/lib/workflows/production.ts",
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
  it("keeps the graph manager and cohort harness independent of production composition", () => {
    const cores = [
      "src/lib/workflow-graph/workflow-manager.ts",
      "src/lib/workflow-graph/testing/cohort-engine-harness.ts",
    ];
    const compositions = [
      "src/lib/workflow-graph/production.ts",
      "src/lib/workflows/production.ts",
      "src/lib/workflows/conversation/lifecycle.ts",
      "src/lib/workflows/conversation/production.ts",
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
      "src/lib/workflows/production",
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
