import { describe, expect, it } from "vitest";
import {
  deriveDefinitionLaneBands,
  deriveExecutionLaneBands,
  deriveExecutionPublication,
  type LaneBandDefinition,
  type LaneBandExecution,
} from "./lane-bands";
import {
  createWorkflowDefinition,
  createWorkflowExecution,
} from "./test-fixtures";
import { applyJoinProgress } from "./context-transitions";

/**
 * The canonical bundle fixture (README §3.2), reduced to the fields the band
 * model reads: six contexts across `plan`, `candidate-rules`, `delivery` and
 * the reserved `session` lane.
 */
function fixtureDefinition(): LaneBandDefinition {
  return {
    executionContexts: [
      { id: "ctx_plan", placement: { lane: "plan", mode: "full" } },
      // Owned paths are omitted: the band model counts grades, and the paths
      // themselves render on the context that declares them, never on a lane.
      {
        id: "ctx_rules",
        placement: { lane: "candidate-rules", mode: "owned" },
      },
      { id: "ctx_checkout", placement: { lane: "delivery", mode: "owned" } },
      { id: "ctx_settings", placement: { lane: "delivery", mode: "owned" } },
      { id: "ctx_rollout", placement: { lane: "delivery", mode: "full" } },
      { id: "ctx_notes", placement: { lane: "session", mode: "readOnly" } },
    ],
    edges: [
      { sourceContextId: "ctx_plan", targetContextId: "ctx_rules" },
      { sourceContextId: "ctx_rules", targetContextId: "ctx_checkout" },
      { sourceContextId: "ctx_checkout", targetContextId: "ctx_settings" },
      { sourceContextId: "ctx_settings", targetContextId: "ctx_rollout" },
      { sourceContextId: "ctx_rollout", targetContextId: "ctx_notes" },
    ],
  };
}

function fixtureExecution(
  overrides: Partial<LaneBandExecution> = {},
): LaneBandExecution {
  return {
    workingDefinition: fixtureDefinition(),
    activeContextIds: ["ctx_checkout", "ctx_settings"],
    contextStates: {
      ctx_plan: { status: "completed" },
      ctx_rules: { status: "completed" },
      ctx_checkout: { status: "running" },
      ctx_settings: { status: "running" },
      ctx_rollout: { status: "pending" },
      ctx_notes: { status: "pending" },
    },
    executionLanes: {
      plan: {
        laneId: "plan",
        kind: "worktree",
        status: "merged",
        branchName: "csm/checkout-v2.plan",
        worktreePath: ".worktrees/checkout-v2.plan",
        includedContextIds: ["ctx_plan"],
      },
      "candidate-rules": {
        laneId: "candidate-rules",
        kind: "worktree",
        status: "merged",
        branchName: "csm/checkout-v2.candidate-rules",
        worktreePath: ".worktrees/checkout-v2.candidate-rules",
        includedContextIds: ["ctx_rules"],
      },
      delivery: {
        laneId: "delivery",
        kind: "worktree",
        status: "active",
        branchName: "csm/checkout-v2.delivery",
        worktreePath: ".worktrees/checkout-v2.delivery",
        includedContextIds: ["ctx_checkout", "ctx_settings", "ctx_rollout"],
      },
      __session__: {
        laneId: "__session__",
        kind: "session",
        status: "pending",
        branchName: "csm/checkout-v2",
        worktreePath: null,
        includedContextIds: ["ctx_notes"],
      },
    },
    joins: {
      "join-plan": {
        kind: "context_merge",
        targetLaneId: "__session__",
        sourceLaneIds: ["plan"],
        status: "succeeded",
      },
      "join-rules": {
        kind: "context_merge",
        targetLaneId: "delivery",
        sourceLaneIds: ["candidate-rules"],
        status: "succeeded",
      },
      "join-publish": {
        kind: "final_publish",
        targetLaneId: "__session__",
        sourceLaneIds: ["delivery"],
        status: "pending",
      },
    },
    ...overrides,
  };
}

describe("deriveDefinitionLaneBands", () => {
  it("summarises a mixed-grade lane by member grade without giving the lane a grade", () => {
    const bands = deriveDefinitionLaneBands(fixtureDefinition());
    const delivery = bands.find((band) => band.laneName === "delivery");

    expect(delivery).toBeDefined();
    expect(delivery?.memberCount).toBe(3);
    expect(delivery?.membershipLabel).toBe("3 members");
    expect(delivery?.gradeSummary).toBe("2 owning · 1 full");
    expect(delivery?.state).toBe("pending");
    expect(delivery?.reserved).toBe(false);
    expect(delivery?.runtime).toBeNull();
    // A lane has no grade of its own (README §4).
    expect(Object.keys(delivery ?? {})).not.toContain("grade");
    expect(Object.keys(delivery ?? {})).not.toContain("mode");
  });

  it("uses the singular membership label for a one-member lane", () => {
    const bands = deriveDefinitionLaneBands(fixtureDefinition());

    expect(bands.find((band) => band.laneName === "plan")).toMatchObject({
      membershipLabel: "1 member",
      gradeSummary: "1 full",
    });
    expect(
      bands.find((band) => band.laneName === "candidate-rules"),
    ).toMatchObject({
      membershipLabel: "1 member",
      gradeSummary: "1 owning",
    });
  });

  it("marks the reserved session lane", () => {
    const bands = deriveDefinitionLaneBands(fixtureDefinition());
    const session = bands.find((band) => band.laneName === "session");

    expect(session).toMatchObject({
      state: "session",
      reserved: true,
      gradeSummary: "1 read-only",
      memberContextIds: ["ctx_notes"],
    });
  });

  it("orders bands dependency-first and members by dependency depth", () => {
    const bands = deriveDefinitionLaneBands(fixtureDefinition());

    expect(bands.map((band) => band.laneName)).toEqual([
      "plan",
      "candidate-rules",
      "delivery",
      "session",
    ]);
    expect(
      bands.find((band) => band.laneName === "delivery")?.memberContextIds,
    ).toEqual(["ctx_checkout", "ctx_settings", "ctx_rollout"]);
  });

  it("returns no bands for a definition with no contexts", () => {
    expect(
      deriveDefinitionLaneBands({ executionContexts: [], edges: [] }),
    ).toEqual([]);
  });

  // The band model is structurally typed so an authored definition feeds it
  // with no adapter; running the shared fixture through it proves that stays
  // true as the definition schema evolves.
  it("derives bands straight from an authored workflow definition", () => {
    const bands = deriveDefinitionLaneBands(createWorkflowDefinition());

    expect(bands.map((band) => band.laneName)).toEqual([
      "plan",
      "implement",
      "verify",
    ]);
    expect(bands[0]).toMatchObject({
      membershipLabel: "1 member",
      gradeSummary: "1 full",
      state: "pending",
      reserved: false,
      runtime: null,
    });
  });
});

describe("deriveExecutionLaneBands", () => {
  it("carries runtime state, branch, worktree and join labels", () => {
    const bands = deriveExecutionLaneBands(fixtureExecution());

    expect(bands.find((band) => band.laneName === "plan")).toMatchObject({
      state: "merged",
      runtime: {
        status: "merged",
        branchLabel: "csm/checkout-v2.plan",
        worktreeLabel: ".worktrees/checkout-v2.plan",
        joinLabel: "joined → session",
        publicationLabel: null,
      },
    });
    expect(
      bands.find((band) => band.laneName === "candidate-rules")?.runtime
        ?.joinLabel,
    ).toBe("joined → delivery");
  });

  it("reports the active lane and its pending publication", () => {
    const bands = deriveExecutionLaneBands(fixtureExecution());
    const delivery = bands.find((band) => band.laneName === "delivery");

    expect(delivery).toMatchObject({
      state: "active",
      gradeSummary: "2 owning · 1 full",
      membershipLabel: "3 members",
      runtime: {
        status: "active",
        branchLabel: "csm/checkout-v2.delivery",
        worktreeLabel: ".worktrees/checkout-v2.delivery",
        joinLabel: null,
        publicationLabel: "publishes → session",
      },
    });
  });

  it("renders the reserved session lane as the publication target", () => {
    const bands = deriveExecutionLaneBands(fixtureExecution());
    const session = bands.find((band) => band.laneName === "session");

    expect(session).toMatchObject({
      state: "session",
      reserved: true,
      gradeSummary: "1 read-only",
      runtime: {
        worktreeLabel: "the session worktree",
        publicationLabel: "publication target",
      },
    });
  });

  it("keeps a halted lane visibly occupied while reporting its engine status", () => {
    const execution = fixtureExecution();
    const bands = deriveExecutionLaneBands({
      ...execution,
      executionLanes: {
        ...execution.executionLanes,
        delivery: {
          laneId: "delivery",
          kind: "worktree",
          status: "halted",
          branchName: "csm/checkout-v2.delivery",
          worktreePath: ".worktrees/checkout-v2.delivery",
          includedContextIds: ["ctx_checkout", "ctx_settings", "ctx_rollout"],
        },
      },
    });

    expect(bands.find((band) => band.laneName === "delivery")).toMatchObject({
      state: "active",
      runtime: { status: "halted" },
    });
  });

  it("treats a lane with no runtime record yet as pending", () => {
    const execution = fixtureExecution();
    const bands = deriveExecutionLaneBands({
      ...execution,
      activeContextIds: [],
      executionLanes: {},
      joins: {},
    });

    expect(bands.find((band) => band.laneName === "delivery")).toMatchObject({
      state: "pending",
      runtime: {
        status: "pending",
        branchLabel: null,
        worktreeLabel: null,
        joinLabel: null,
        publicationLabel: null,
      },
    });
  });

  // Same structural proof on the execution side: a real persisted execution is
  // a valid band-model input with no adapter.
  it("derives bands straight from a persisted execution", () => {
    const bands = deriveExecutionLaneBands(createWorkflowExecution());

    expect(bands.map((band) => band.laneName)).toEqual([
      "plan",
      "implement",
      "verify",
    ]);
    expect(bands[0]?.runtime).toMatchObject({
      status: "pending",
      branchLabel: null,
      worktreeLabel: null,
    });
  });

  it("includes a lane created at runtime by expansion", () => {
    const execution = fixtureExecution();
    const bands = deriveExecutionLaneBands({
      ...execution,
      contextStates: {
        ...execution.contextStates,
        ctx_generated: { status: "running", laneId: "delivery.spawn" },
      },
      executionLanes: {
        ...execution.executionLanes,
        "delivery.spawn": {
          laneId: "delivery.spawn",
          kind: "worktree",
          status: "active",
          branchName: "csm/checkout-v2.delivery.spawn",
          worktreePath: ".worktrees/checkout-v2.delivery.spawn",
          includedContextIds: ["ctx_generated"],
        },
      },
    });

    expect(
      bands.find((band) => band.laneName === "delivery.spawn"),
    ).toMatchObject({
      state: "active",
      memberContextIds: ["ctx_generated"],
      membershipLabel: "1 member",
    });
  });

  // The production shape behind ticket #103: `workflow-gate` was forked from
  // `cli-contract` after `recovery-strings` landed there, so its lane record
  // lists that context among the output its branch carries. The band must keep
  // the context under the lane it is placed on — the lane the card's chip names
  // and the layout positions it in — rather than let the fork claim it.
  it("keeps a landed context in its placed lane when a downstream lane forked from it", () => {
    const bands = deriveExecutionLaneBands({
      workingDefinition: {
        executionContexts: [
          {
            id: "id-boundary-validation",
            placement: { lane: "cli-contract", mode: "owned" },
          },
          {
            id: "recovery-strings",
            placement: { lane: "cli-contract", mode: "owned" },
          },
          {
            id: "doctor-and-coverage-help",
            placement: { lane: "cli-contract", mode: "full" },
          },
          {
            id: "gate-single-evaluation",
            placement: { lane: "workflow-gate", mode: "full" },
          },
        ],
        edges: [
          {
            sourceContextId: "id-boundary-validation",
            targetContextId: "doctor-and-coverage-help",
          },
          {
            sourceContextId: "recovery-strings",
            targetContextId: "doctor-and-coverage-help",
          },
          {
            sourceContextId: "recovery-strings",
            targetContextId: "gate-single-evaluation",
          },
        ],
      },
      contextStates: {
        "id-boundary-validation": { status: "ready", laneId: "cli-contract" },
        "recovery-strings": { status: "completed", laneId: "cli-contract" },
        "doctor-and-coverage-help": { status: "pending" },
        "gate-single-evaluation": {
          status: "completed",
          laneId: "workflow-gate",
        },
      },
      executionLanes: {
        "cli-contract": {
          laneId: "cli-contract",
          kind: "worktree",
          status: "active",
          branchName: "csm/audit-cli-contract",
          includedContextIds: ["recovery-strings"],
        },
        "workflow-gate": {
          laneId: "workflow-gate",
          kind: "worktree",
          status: "active",
          branchName: "csm/audit-workflow-gate",
          includedContextIds: ["recovery-strings", "gate-single-evaluation"],
        },
      },
    });

    expect(
      bands.find((band) => band.laneName === "cli-contract"),
    ).toMatchObject({
      memberContextIds: [
        "id-boundary-validation",
        "recovery-strings",
        "doctor-and-coverage-help",
      ],
      membershipLabel: "3 members",
      gradeSummary: "2 owning · 1 full",
    });
    expect(
      bands.find((band) => band.laneName === "workflow-gate"),
    ).toMatchObject({
      memberContextIds: ["gate-single-evaluation"],
      membershipLabel: "1 member",
      gradeSummary: "1 full",
    });
  });

  // The band fixtures above hand-write `status: "merged"`, so they cannot catch
  // an engine that never produces it. This one starts from the real transition
  // owner: a lane whose work the join runner has just landed must read as
  // merged on the canvas, not as the live lane it was a moment earlier.
  it("shows a lane the join runner merged as merged, not active", () => {
    const execution = createWorkflowExecution({
      joins: {
        "join-1": {
          joinId: "join-1",
          kind: "context_merge",
          contextId: "context-implement",
          targetLaneId: "delivery",
          sourceLaneIds: ["plan"],
          mergedSourceLaneIds: [],
          validationDebtSourceLaneIds: [],
          status: "running",
          errorMessage: null,
          conflicts: null,
          conflictGuidance: null,
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
          completedAt: null,
        },
      },
      executionLanes: {
        plan: {
          laneId: "plan",
          kind: "worktree",
          status: "active",
          worktreePath: ".worktrees/checkout-v2.plan",
          branchName: "csm/checkout-v2.plan",
          includedContextIds: ["ctx_plan"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
        delivery: {
          laneId: "delivery",
          kind: "worktree",
          status: "active",
          worktreePath: ".worktrees/checkout-v2.delivery",
          branchName: "csm/checkout-v2.delivery",
          includedContextIds: ["ctx_checkout"],
          lastCommittingContextId: null,
          commitSnapshots: [],
          createdAt: "2026-07-12T00:00:00.000Z",
          updatedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    });

    const afterMerge = applyJoinProgress(
      execution,
      "join-1",
      "2026-07-12T12:00:00.000Z",
      { status: "running", addMergedSourceLaneId: "plan" },
    );
    const bands = deriveExecutionLaneBands({
      ...afterMerge,
      workingDefinition: fixtureDefinition(),
    });

    expect(bands.find((band) => band.laneName === "plan")).toMatchObject({
      state: "merged",
      runtime: { status: "merged" },
    });
    expect(bands.find((band) => band.laneName === "delivery")?.state).toBe(
      "active",
    );
  });
});

describe("deriveExecutionPublication — the E1 publication pill", () => {
  it("names the source lane, the target lane and the completion condition", () => {
    expect(deriveExecutionPublication(fixtureExecution())).toEqual({
      sourceLaneNames: ["delivery"],
      targetLaneName: "session",
      state: "pending",
      condition: "after every member completes",
      label: "publication: delivery → session, after every member completes",
    });
  });

  /**
   * The reported defect, at the run level: while the publish was actually
   * running the pill still read "after every member completes" — a precondition
   * that had already been met, which is indistinguishable from not started.
   */
  it("reports lane-by-lane progress while the publish is running", () => {
    const execution = fixtureExecution({
      joins: {
        "join-publish": {
          kind: "final_publish",
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery", "candidate-rules"],
          mergedSourceLaneIds: ["candidate-rules"],
          status: "running",
        },
      },
    });

    expect(deriveExecutionPublication(execution)).toMatchObject({
      state: "running",
      condition: "1 of 2 lanes merged",
      label:
        "publishing: delivery and candidate-rules → session, 1 of 2 lanes merged",
    });
  });

  it("states a failed publish as a failure, with the conflict count it carries", () => {
    const execution = fixtureExecution({
      joins: {
        "join-publish": {
          kind: "final_publish",
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          status: "conflicts",
          conflicts: { files: ["src/a.ts", "src/b.ts", "src/c.ts"] },
        },
      },
    });

    expect(deriveExecutionPublication(execution)).toMatchObject({
      state: "failed",
      condition: "3 conflicted files",
      label: "publish failed: delivery → session, 3 conflicted files",
    });
  });

  it("states a failure with no recorded conflicts without inventing a count", () => {
    const execution = fixtureExecution({
      joins: {
        "join-publish": {
          kind: "final_publish",
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          status: "failed",
        },
      },
    });

    expect(deriveExecutionPublication(execution)).toMatchObject({
      state: "failed",
      condition: "merge failed",
      label: "publish failed: delivery → session, merge failed",
    });
  });

  it("states the outcome instead of the condition once the publish succeeded", () => {
    const execution = fixtureExecution({
      joins: {
        "join-publish": {
          kind: "final_publish",
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery"],
          status: "succeeded",
        },
      },
    });

    expect(deriveExecutionPublication(execution)?.label).toBe(
      "publication: delivery → session, published",
    );
  });

  it("joins several publishing lanes into one statement", () => {
    const execution = fixtureExecution({
      joins: {
        "join-publish": {
          kind: "final_publish",
          targetLaneId: "__session__",
          sourceLaneIds: ["delivery", "candidate-rules"],
          status: "pending",
        },
      },
    });

    expect(deriveExecutionPublication(execution)?.label).toBe(
      "publication: delivery and candidate-rules → session, after every member completes",
    );
  });

  it("has no pill when the run plans no final publish", () => {
    const execution = fixtureExecution({
      joins: {
        "join-rules": {
          kind: "context_merge",
          targetLaneId: "delivery",
          sourceLaneIds: ["candidate-rules"],
          status: "succeeded",
        },
      },
    });

    expect(deriveExecutionPublication(execution)).toBeNull();
  });
});
