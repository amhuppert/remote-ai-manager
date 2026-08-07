import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Decision D1's enforcement: every RUNTIME consumer reads projection-resolved
 * edges, not `edge.sourceContextId`.
 *
 * The distinction the allowlist encodes is topology vs. runtime. Authoring,
 * validation, layout and the seed-time lane plan all reason about the graph the
 * author DREW, where the authored source is the right answer and there is no
 * execution to resolve against. Anything that decides landing, lane visibility,
 * scheduling or injected data must go through `projectExecutionRoutes` /
 * `routeUpstreamContextIds` instead: the raw source waits on branches the
 * routing declined, and — once loops land — on a declared exit context that
 * never runs.
 *
 * A new file that reads the raw field fails here until it is either migrated or
 * added below with the reason it is topological.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SEARCH_ROOTS = ["src/lib", "src/components", "src/features", "src/cli"];

/** Files licensed to read the AUTHORED source, each with the reason why. */
const TOPOLOGY_READERS: Readonly<Record<string, string>> = {
  // The projection itself and its adapter — where the resolution happens.
  "src/lib/workflow-graph/route-projection.ts":
    "owns the edge-resolution table; the raw field is its input",
  "src/lib/workflow-graph/execution-routes.ts":
    "marshals the execution into the projection",
  "src/lib/workflow-graph/route-control-revision.ts":
    "diffs a source's authored route-control surface",

  // Authoring, validation and persistence of the drawn graph.
  "src/lib/workflow-graph/validation.ts": "structural graph validation",
  "src/lib/workflow-graph/edge-guard-validation.ts":
    "authoring-time guard validation",
  "src/lib/workflow-graph/edge-identity.ts": "mints and repairs edge ids",
  "src/lib/workflow-graph/definition-edits.ts": "saved-tier structural edits",
  "src/lib/workflow-graph/runtime-edits.ts": "live-tier structural edits",
  "src/lib/workflow-graph/expansion-service.ts":
    "'downstream of the invoker' is a claim about the graph the PLANNER drew, and an expansion's rejoin targets are unstarted by construction — nothing has resolved for the projection to answer with",
  "src/lib/workflow-graph/builder-draft.ts": "the authoring draft",
  "src/lib/workflow-graph/loop-resolver.ts":
    "validates and clones authored loop bodies",
  "src/lib/workflows/edit-schemas.ts": "declares the edit vocabulary",
  "src/lib/specs/execution-contract.ts": "walks the authored graph statically",

  // Views of the drawn graph: position, declared dependencies, provenance.
  "src/lib/workflow-graph/layout.ts": "lays out the drawn graph",
  "src/lib/workflow-graph/lane-plan.ts":
    "seed-time continuation plan over the authored topology",
  "src/lib/workflow-graph/live-outline.ts":
    "renders DECLARED dependencies; an unstarted context has no resolved ones",
  "src/cli/commands/workflow-outline.ts":
    "definition-tier outline; there is no execution to resolve against",
  "src/lib/workflow-graph/context-outputs.ts":
    "definition-tier upstream walk; the execution-tier resolver above it is projection-resolved",
  "src/components/workflow-graph/derive-graph.ts":
    "renders the LOGICAL edge as topology; its status follows the effective source",
};

/**
 * The modules that decide whether work runs, where it lands, and what it reads.
 * Listed explicitly so the check states its subject rather than relying on a
 * repo-wide sweep to happen to cover them.
 */
const RUNTIME_CONSUMERS = [
  "src/lib/workflow-graph/execution-loop.ts",
  "src/lib/workflow-graph/workflow-manager.ts",
  "src/lib/workflow-graph/lane-readiness.ts",
  "src/lib/workflow-graph/lane-join.ts",
  "src/lib/workflow-graph/iteration-orchestrator.ts",
  "src/lib/workflow-graph/join-runner.ts",
  "src/components/workflow-graph/derive-wait-state.ts",
];

/**
 * A READ of an edge's authored source. Property DECLARATIONS
 * (`sourceContextId: z.string()`) are not reads, and neither are reads of the
 * same-named field on the records D4 added — a route settlement, its event, and
 * the routing halts all name their subject `sourceContextId(s)` and have no
 * authored edge in sight.
 */
const RAW_SOURCE_READ = /(\w+)\.sourceContextId\b/g;
const NON_EDGE_RECEIVERS = new Set([
  "event",
  "reason",
  "record",
  "settlement",
  "outcome",
]);

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

function readsAuthoredEdgeSource(relPath: string): boolean {
  return [...read(relPath).matchAll(RAW_SOURCE_READ)].some(
    (match) => !NON_EDGE_RECEIVERS.has(match[1] ?? ""),
  );
}

function collectSourceFiles(relRoot: string): string[] {
  const absRoot = path.join(REPO_ROOT, relRoot);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      if (/\.(test|stories)\.tsx?$/.test(entry)) continue;
      if (/testing|test-fixtures/.test(abs)) continue;
      found.push(path.relative(REPO_ROOT, abs));
    }
  };
  walk(absRoot);
  return found;
}

describe("projection-resolved edges (D4 decision D1)", () => {
  it.each(RUNTIME_CONSUMERS)(
    "%s resolves edges through the projection rather than reading the authored source",
    (relPath) => {
      expect(readsAuthoredEdgeSource(relPath)).toBe(false);
    },
  );

  it("no unlisted module reads the authored edge source", () => {
    const offenders = SEARCH_ROOTS.flatMap(collectSourceFiles)
      .filter(readsAuthoredEdgeSource)
      .filter((relPath) => !(relPath in TOPOLOGY_READERS));

    expect(offenders).toEqual([]);
  });

  it("every licensed topology reader still exists and still reads the field", () => {
    // Keeps the allowlist from silently outliving its entries: a migrated file
    // must be REMOVED from it, not left as a standing licence.
    const stale = Object.keys(TOPOLOGY_READERS).filter(
      (relPath) => !readsAuthoredEdgeSource(relPath),
    );

    expect(stale).toEqual([]);
  });
});
