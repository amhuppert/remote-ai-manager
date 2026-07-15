import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Architecture test (Phase 4.4 schema-partition, review finding 1): the
 * `GraphWorkflow*` schema family has one owner — `src/lib/workflow-graph/`.
 * The generic `src/lib/workflows/` domain holds only graph-neutral workflow
 * primitives (AgentCall, Lane, WorkflowEnvelope, gates, artifacts, charter,
 * live-edit operations, the collaboration facade) and must NEVER re-acquire a
 * graph-specific schema/type declaration.
 *
 * This scan rejects, anywhere under `src/lib/workflows/`:
 *   - `export const graphWorkflow…Schema` (the graph config/definition/
 *     collaboration-persistence Zod family, including graph context, task,
 *     edge, status, and layout schemas — all `graphWorkflow`-prefixed)
 *   - `export type GraphWorkflow…` (their inferred type twins)
 *
 * The direction is one-way: `workflow-graph/` owns these and `workflows/`
 * modules import them (a consumer edge, not ownership). If a graph schema
 * needs to change, it changes in `workflow-graph/` alone — never leaking graph
 * knowledge back into the reusable workflow domain.
 */

const WORKFLOWS_ROOT = __dirname;

// `export const graphWorkflowXxxSchema` — the whole graph Zod family. The
// `graphWorkflow` prefix spans config (agent/validator/mutability/circuit-
// breaker/iteration/approval/questions), definition (context/task/edge/status/
// layout/shared-document/definition-record/plan), and collaboration-persistence
// schemas, so this single pattern covers the "graph context/task/edge/status/
// layout schema" families the review named.
const GRAPH_SCHEMA_EXPORT = /\bexport\s+const\s+graphWorkflow\w*Schema\b/g;

// `export type GraphWorkflowXxx` — the inferred type twins of the above.
const GRAPH_TYPE_EXPORT = /\bexport\s+type\s+GraphWorkflow\w*/g;

function listDomainSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "node_modules") continue;
      out.push(...listDomainSourceFiles(full));
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

function matchingLines(source: string, pattern: RegExp): string[] {
  const hits: string[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    // Reset lastIndex per line since the pattern is global.
    pattern.lastIndex = 0;
    if (pattern.test(line)) hits.push(`${i + 1}: ${line.trim()}`);
  }
  return hits;
}

describe("workflows domain owns no graph schemas", () => {
  it("declares no `export const graphWorkflow…Schema` under src/lib/workflows/", () => {
    const offenders: string[] = [];
    for (const file of listDomainSourceFiles(WORKFLOWS_ROOT)) {
      const rel = path.relative(WORKFLOWS_ROOT, file);
      const hits = matchingLines(
        readFileSync(file, "utf8"),
        GRAPH_SCHEMA_EXPORT,
      );
      for (const hit of hits) offenders.push(`${rel}:${hit}`);
    }
    expect(
      offenders,
      `graph schemas must be declared in src/lib/workflow-graph/, not src/lib/workflows/:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("declares no `export type GraphWorkflow…` under src/lib/workflows/", () => {
    const offenders: string[] = [];
    for (const file of listDomainSourceFiles(WORKFLOWS_ROOT)) {
      const rel = path.relative(WORKFLOWS_ROOT, file);
      const hits = matchingLines(readFileSync(file, "utf8"), GRAPH_TYPE_EXPORT);
      for (const hit of hits) offenders.push(`${rel}:${hit}`);
    }
    expect(
      offenders,
      `graph types must be declared in src/lib/workflow-graph/, not src/lib/workflows/:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
