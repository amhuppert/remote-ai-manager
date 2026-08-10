import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DEFINITION_TIER_KEYS } from "@/lib/state-store/graph-workflow-executions-repo";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { STRUCTURAL_REVISION_KEYS } from "@/lib/workflow-graph/structural-revision";
import { createWorkflowExecution } from "@/lib/workflow-graph/test-fixtures";

/**
 * R2.1's enforcement: deterministic seed-time lane assignment is DELETED, not
 * deprecated.
 *
 * Two placement authorities is the failure mode locked fork F1 exists to
 * prevent — a definition says one thing, a seed-time score says another, and
 * the scheduler silently picks. So the check is structural rather than
 * behavioural: the module, its vocabulary, and its persisted field must be
 * absent from the tree, because anything that survives is something a later
 * change can start consulting again.
 *
 * The token sweep covers tests and fixtures too. `lanePlan` and its two record
 * names are coined by the deleted planner and by nothing else, so a hit
 * anywhere is a resurrection, and a fixture that still carries the field is how
 * a removed field quietly comes back.
 */

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SEARCH_ROOT = "src";

/** The deleted planner's vocabulary, in any file. */
const PLANNER_TOKENS = [
  "lanePlan",
  "continuationMap",
  "longestDownstreamPath",
] as const;

/** An import of the deleted module by either specifier form. */
const PLANNER_IMPORT =
  /from\s+["'](?:@\/lib\/workflow-graph|\.)\/lane-plan["']/;

/**
 * The files licensed to still spell the vocabulary, each because its subject IS
 * the removal: this check has to name what it searches for, and the migration
 * has to name the field it deletes from stored bytes.
 */
const REMOVAL_PATH = new Set([
  "src/lib/workflow-graph/placement-migration.ts",
  "src/lib/workflow-graph/placement-migration.test.ts",
  "src/lib/state-store/migrations/0016-graph-workflow-context-placement.ts",
  "src/lib/state-store/migrations/0016-graph-workflow-context-placement.test.ts",
]);

function collectSourceFiles(relRoot: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = path.join(dir, entry);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      found.push(path.relative(REPO_ROOT, abs));
    }
  };
  walk(path.join(REPO_ROOT, relRoot));
  return found;
}

describe("deterministic lane assignment is removed (R2.1)", () => {
  it.each(["lane-plan.ts", "lane-plan.test.ts"])(
    "src/lib/workflow-graph/%s no longer exists",
    (fileName) => {
      expect(
        existsSync(path.join(REPO_ROOT, "src/lib/workflow-graph", fileName)),
      ).toBe(false);
    },
  );

  it("no file names the deleted planner's vocabulary or imports it", () => {
    const self = path.relative(REPO_ROOT, __filename);
    const offenders = collectSourceFiles(SEARCH_ROOT)
      .filter((relPath) => relPath !== self && !REMOVAL_PATH.has(relPath))
      .filter((relPath) => {
        const source = readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
        return (
          PLANNER_IMPORT.test(source) ||
          PLANNER_TOKENS.some((token) => source.includes(token))
        );
      });

    expect(offenders).toEqual([]);
  });

  it("the execution schema drops a stored lanePlan instead of carrying it", () => {
    const parsed = graphWorkflowExecutionSchema.parse({
      ...createWorkflowExecution(),
      lanePlan: {
        continuationMap: { "context-plan": "context-implement" },
        longestDownstreamPath: { "context-plan": 2 },
      },
    });

    expect(parsed).not.toHaveProperty("lanePlan");
  });

  it("the persistence tier mapping and the structural-revision key set no longer carry it", () => {
    expect([...DEFINITION_TIER_KEYS]).not.toContain("lanePlan");
    expect([...STRUCTURAL_REVISION_KEYS]).not.toContain("lanePlan");
  });
});
