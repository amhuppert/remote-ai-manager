/**
 * The placement save gate: what the panel refuses before it ever submits.
 *
 * The point of these cases is the split. A malformed declaration is decidable
 * from the placement alone; a lane-concurrency violation is not, and a
 * single-declaration check cannot see it — a context moved onto a sibling's
 * lane with overlapping owned paths sails through the UI and is refused at the
 * frontier.
 *
 * The last two cases pin the gate to the frontier's own trigger rather than to
 * a plausible-sounding one: a placement edit is judged as a WHOLE definition
 * (so a violation elsewhere blocks), and an untouched placement is not judged
 * at all (so a pre-existing violation strands nobody).
 */
import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowResolvedContext,
  ContextPlacement,
} from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import {
  createWorkflowExecution,
  makeProfileSnapshot,
} from "@/lib/workflow-graph/test-fixtures";
import { livePlacementIssue } from "./live-placement-gate";

function context(
  id: string,
  placement: ContextPlacement,
): GraphWorkflowResolvedContext {
  return {
    id,
    title: id,
    acceptanceCriteria: "It works",
    placement,
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    },
    contextValidator: { enabled: false, assignments: [] },
    scriptValidator: { commands: [] },
    humanApprovalGate: { enabled: false },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: false },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  };
}

function execution(
  contexts: GraphWorkflowResolvedContext[],
): GraphWorkflowExecution {
  return createWorkflowExecution({
    status: "paused",
    workingDefinition: {
      schemaVersion: 1,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
      executionContexts: contexts,
      tasks: [],
      edges: [],
    },
    activeContextIds: [],
    contextStates: {},
    taskStates: {},
  });
}

const MINE = "context-mine";
const SIBLING = "context-sibling";

describe("livePlacementIssue", () => {
  it("accepts a legal move onto a lane whose members stay disjoint", () => {
    const exec = execution([
      context(MINE, { lane: "delivery", mode: "owned", ownedPaths: ["src/a"] }),
      context(SIBLING, {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/b"],
      }),
    ]);

    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        placement: { lane: "review", mode: "owned", ownedPaths: ["src/a"] },
      }),
    ).toBeNull();
  });

  it("reports the malformed declaration before consulting the definition", () => {
    const exec = execution([context(MINE, { lane: "delivery", mode: "full" })]);

    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        placement: { lane: "bad lane", mode: "full" },
      }),
    ).toContain("Lane names become branch and worktree path segments");
  });

  it("refuses a move onto a concurrent sibling's lane with overlapping paths", () => {
    // The case a single-declaration check cannot see: both placements are
    // perfectly legal on their own, and only the pair is illegal.
    const exec = execution([
      context(MINE, { lane: "delivery", mode: "owned", ownedPaths: ["src/a"] }),
      context(SIBLING, {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/a/nested"],
      }),
    ]);

    const issue = livePlacementIssue({
      execution: exec,
      contextId: MINE,
      placement: { lane: "review", mode: "owned", ownedPaths: ["src/a"] },
    });

    expect(issue).not.toBeNull();
    expect(issue).toMatch(/src\/a/);
  });

  it("refuses taking a lane exclusively when a concurrent member already writes it", () => {
    const exec = execution([
      context(MINE, { lane: "delivery", mode: "owned", ownedPaths: ["src/a"] }),
      context(SIBLING, {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/b"],
      }),
    ]);

    // `full` declares no surface to be disjoint from, so it needs the lane alone.
    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        placement: { lane: "review", mode: "full" },
      }),
    ).not.toBeNull();
  });

  it("reports a violation elsewhere in the definition, because a placement edit is judged whole", () => {
    // Parity with the frontier, which is the only verdict that matters: once a
    // batch touches placement at all, `checkPlacements` runs `validatePlacements`
    // over the WHOLE post-batch definition and refuses on ANY error — including
    // one this author did not cause. Staying silent here would enable Save on a
    // draft the runtime is certain to reject, which is worse than naming a
    // violation the author has to go and resolve.
    const exec = execution([
      context(MINE, { lane: "delivery", mode: "full" }),
      context("context-a", {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/shared"],
      }),
      context("context-b", {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/shared/deep"],
      }),
    ]);

    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        placement: { lane: "delivery-two", mode: "full" },
      }),
    ).toMatch(/src\/shared/);
  });

  it("stays silent on a placement the draft never moved", () => {
    // The mirror of the case above, and the reason the gate cannot simply run
    // the composite unconditionally: an untouched placement leaves
    // `placementTouched` false, so the frontier asks nothing at all — and a
    // pre-existing violation must not strand an author editing something else
    // entirely.
    const existing: ContextPlacement = { lane: "delivery", mode: "full" };
    const exec = execution([
      context(MINE, existing),
      context("context-a", {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/shared"],
      }),
      context("context-b", {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/shared/deep"],
      }),
    ]);

    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        // Structurally equal, freshly constructed: the draft holds its own copy.
        placement: { lane: "delivery", mode: "full" },
      }),
    ).toBeNull();
    expect(
      livePlacementIssue({
        execution: exec,
        contextId: MINE,
        placement: existing,
      }),
    ).toBeNull();
  });
});
