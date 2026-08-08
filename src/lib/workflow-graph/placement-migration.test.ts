import { describe, expect, it } from "vitest";
import { decodeGraphWorkflowExecution } from "@/lib/state-store/graph-workflow-execution-codec";
import { validateWorkflowPlan } from "@/lib/workflows/plan-validation";
import { laneIdViolation, SESSION_LANE_NAME } from "./lane-identity";
import { SESSION_LANE_ID } from "./lane-join";
import { migrateRawDefinitionPlacement } from "./placement-migration";
import { assertDefinitionRecordSupported } from "./schema-cutover-guard";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
} from "./test-fixtures";

/**
 * R11.1: a definition authored before placement existed still loads and still
 * runs, and does so with the semantics it had — one worktree per context.
 *
 * The transformer is reachable ONLY from the stored-inflate boundaries, so most
 * checks below go through those boundaries rather than the pure function: a
 * migration that authoring could reach would let a placement-less submission
 * through, which is the one thing R11 forbids.
 */

/** Strip placement from every context, as a pre-placement document has it. */
function withoutPlacement<T>(definition: T): T {
  const clone = structuredClone(definition) as {
    executionContexts: Array<Record<string, unknown>>;
  };
  for (const context of clone.executionContexts) {
    delete context.placement;
  }
  return clone as T;
}

function lanesOf(definition: {
  executionContexts: ReadonlyArray<{ id: string; placement: { lane: string } }>;
}): Record<string, string> {
  return Object.fromEntries(
    definition.executionContexts.map((context) => [
      context.id,
      context.placement.lane,
    ]),
  );
}

/** Migrate a bare context-id list and read back the lane each one landed on. */
function lanesFor(contextIds: readonly string[]): string[] {
  const raw: { executionContexts: Array<{ id: string }> } = {
    executionContexts: contextIds.map((id) => ({ id })),
  };

  migrateRawDefinitionPlacement(raw);

  return (
    raw as unknown as {
      executionContexts: Array<{ placement: { lane: string } }>;
    }
  ).executionContexts.map((context) => context.placement.lane);
}

describe("pre-placement definitions migrate at the stored-load boundary (R11.1)", () => {
  it("puts every context of a stored definition on its own lane named after it", () => {
    const record = createWorkflowDefinitionRecord({
      definition: withoutPlacement(createWorkflowDefinition()),
    });

    const loaded = assertDefinitionRecordSupported(
      JSON.parse(JSON.stringify(record)),
    );

    // One lane per context, each single-member: the one-worktree-per-context
    // semantics the definition was authored under.
    expect(lanesOf(loaded.definition)).toEqual({
      "context-plan": "context-plan",
      "context-implement": "context-implement",
      "context-verify": "context-verify",
    });
    for (const context of loaded.definition.executionContexts) {
      expect(context.placement.mode).toBe("full");
    }
  });

  it("distinguishes context ids that sanitize to the same lane segment", () => {
    expect(lanesFor(["build api", "build/api", "build+api"])).toEqual([
      "build_api",
      "build_api-2",
      "build_api-3",
    ]);
  });

  it.each([
    // A context id accepts any non-empty string; a lane name does not. Each
    // pair is the deterministic encoding of one way out of the charset.
    ["../escape", "__escape", "parent segments cannot survive in a path"],
    [".hidden", "hidden", "a leading dot is illegal"],
    ["-leading", "leading", "a leading dash is illegal"],
    ["trailing-", "trailing", "a trailing dash is illegal"],
    ["plan step", "plan_step", "a space is outside the charset"],
    ["refs.lock", "refs.lock_", "git refuses a .lock suffix"],
    ["-", "context", "nothing legal survives, so the fallback names it"],
    [SESSION_LANE_NAME, "session-2", "the authored session lane is reserved"],
    [SESSION_LANE_ID, "__session__-2", "the internal session lane is reserved"],
  ])("encodes the context id %j as the legal lane %j (%s)", (id, expected) => {
    expect(lanesFor([id])).toEqual([expected]);
    expect(laneIdViolation(expected)).toBeNull();
  });

  it("reads a stored execution that predates placement and carries lanePlan, dropping the field", () => {
    const base = createWorkflowExecution();
    const stored = {
      ...base,
      workingDefinition: withoutPlacement(base.workingDefinition),
      lanePlan: {
        continuationMap: { "context-plan": "context-implement" },
        longestDownstreamPath: { "context-plan": 2 },
      },
    };

    const decoded = decodeGraphWorkflowExecution(
      JSON.parse(JSON.stringify(stored)),
    );

    expect(decoded.ok).toBe(true);
    if (!decoded.ok || decoded.value === null) return;
    expect(decoded.value).not.toHaveProperty("lanePlan");
    expect(lanesOf(decoded.value.workingDefinition)).toEqual({
      "context-plan": "context-plan",
      "context-implement": "context-implement",
      "context-verify": "context-verify",
    });
  });

  it("still refuses a placement-less definition submitted through the authoring path", () => {
    const result = validateWorkflowPlan({
      name: "Legacy",
      definition: withoutPlacement(createWorkflowDefinition()),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.issues.some((issue) => issue.path.includes("placement")),
    ).toBe(true);
  });
});
