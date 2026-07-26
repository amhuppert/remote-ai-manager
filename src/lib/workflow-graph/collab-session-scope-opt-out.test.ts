/**
 * Graph-workflow opt-out pin for the CC task session scope.
 *
 * Granting a task subprocess the originating session's CC identity hands it a
 * server-resolved instance token, so it is opt-in per composition site. Only
 * standalone collaboration (one attended logical turn owned by a real user
 * conversation) opts in. Graph-workflow collaboration shares the same
 * production caller factory, so nothing but this pin stops a later edit from
 * silently extending the grant to every lane — and a graph lane's task runs
 * must stay neutralized.
 *
 * Static rather than behavioral because the property is "this composition site
 * never passes the flag": the graph entry point imports the factory directly,
 * and a runtime assertion would have to boot the whole workflow-graph lane
 * loader to observe an argument that is simply absent.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const GRAPH_ROOT = __dirname;

function readGraphSource(file: string): string {
  return readFileSync(path.join(GRAPH_ROOT, file), "utf8");
}

function productionGraphSources(): string[] {
  return readdirSync(GRAPH_ROOT).filter(
    (file) =>
      file.endsWith(".ts") &&
      !file.endsWith(".test.ts") &&
      !file.endsWith(".test.tsx"),
  );
}

describe("graph-workflow collaboration task environment", () => {
  it("composes the collaboration production caller without a session-scope grant", () => {
    const source = readGraphSource("lane-tool-context-loader.ts");

    expect(source).toContain("createCollaborationProductionAgentCaller(");
    expect(source).not.toContain("grantsOriginatingSessionScope");
  });

  it("never grants CC session identity to a task subprocess anywhere in workflow-graph", () => {
    const granting = productionGraphSources().filter((file) => {
      const source = readGraphSource(file);
      return (
        source.includes("grantsOriginatingSessionScope") ||
        source.includes("ccSessionScope")
      );
    });

    expect(granting).toEqual([]);
  });
});
