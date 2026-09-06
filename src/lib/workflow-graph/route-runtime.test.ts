import { describe, expect, it } from "vitest";

import {
  collectLandingCommitRepairs,
  collectLandingProbeTargets,
  recordLandingIntent,
  reconcileLandingIntents,
  settleLandingIntent,
  settleRoutes,
} from "@/lib/workflow-graph/route-runtime";
import { isRouteSourceLanded } from "@/lib/workflow-graph/lane-readiness";
import { getEligibleContextIds } from "@/lib/workflow-graph/validation";
import { projectExecutionRoutes } from "@/lib/workflow-graph/execution-routes";
import {
  applyLiveExecutionEdits,
  type LiveEditDeps,
} from "@/lib/workflow-graph/runtime-edits";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
} from "@/lib/workflow-graph/test-fixtures";
import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionContextState,
} from "@/lib/workflow-graph/schemas";
import type {
  GraphWorkflowContextEdge,
  ResolvedWorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";

const NOW = "2026-08-04T10:00:00.000Z";
const LATER = "2026-08-04T11:00:00.000Z";

const VERDICT_SCHEMA = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
} as const;

/**
 * A classifier fanning out to two guarded branches plus a join, which is the
 * smallest graph that exercises activation, skip, skip ripple and cardinality
 * at once.
 */
function classifierDefinition(
  edgeOverrides: readonly Partial<GraphWorkflowContextEdge>[] = [],
): ResolvedWorkflowSemanticDefinition {
  const base = createResolvedWorkflowDefinition();
  const template = base.executionContexts[0]!;
  const context = (id: string, extra: Record<string, unknown> = {}) => ({
    ...template,
    id,
    title: id,
    ...extra,
  });
  const edges: GraphWorkflowContextEdge[] = [
    {
      id: "classify__fix",
      sourceContextId: "classify",
      targetContextId: "fix",
      when: {
        schema: {
          ...VERDICT_SCHEMA,
          properties: { verdict: { const: "fix" } },
        },
      },
    },
    {
      id: "classify__ship",
      sourceContextId: "classify",
      targetContextId: "ship",
      when: {
        schema: {
          ...VERDICT_SCHEMA,
          properties: { verdict: { const: "ship" } },
        },
      },
    },
    { id: "fix__report", sourceContextId: "fix", targetContextId: "report" },
    { id: "ship__report", sourceContextId: "ship", targetContextId: "report" },
  ];
  return {
    ...base,
    executionContexts: [
      context("classify", { outputSchema: VERDICT_SCHEMA }),
      context("fix"),
      context("ship"),
      context("report"),
    ],
    tasks: ["classify", "fix", "ship", "report"].map((id, index) => ({
      id: `task-${id}`,
      contextId: id,
      order: 1,
      title: `Task ${index}`,
      instructions: "do it",
      source: "user" as const,
    })),
    edges: edges.map((edge, index) => ({ ...edge, ...edgeOverrides[index] })),
  };
}

function contextState(
  contextId: string,
  overrides: Partial<GraphWorkflowExecutionContextState> = {},
): GraphWorkflowExecutionContextState {
  return {
    contextId,
    status: "pending",
    totalTaskCount: 1,
    completedTaskCount: 0,
    iterationCount: 0,
    consecutiveFailureCount: 0,
    consecutiveCandidateMismatchCount: 0,
    worktreePath: null,
    branchName: null,
    isolation: "session",
    batchId: null,
    laneId: null,
    joinId: null,
    mergeStatus: "not-applicable",
    cleanupStatus: "not-applicable",
    lastMergeError: null,
    pendingApproval: null,
    pendingUserInputs: {},
    skipReason: null,
    landingIntent: null,
    ...overrides,
  };
}

/** A completed source whose work landed on the session worktree. */
function landedSource(
  contextId: string,
  overrides: Partial<GraphWorkflowExecutionContextState> = {},
): GraphWorkflowExecutionContextState {
  return contextState(contextId, {
    status: "completed",
    completedTaskCount: 1,
    isolation: "session",
    ...overrides,
  });
}

function classifierExecution(
  options: {
    verdict?: string;
    classifyStatus?: GraphWorkflowExecutionContextState["status"];
    definition?: ResolvedWorkflowSemanticDefinition;
    contextStates?: Record<string, GraphWorkflowExecutionContextState>;
    routing?: Record<string, unknown>;
  } = {},
): GraphWorkflowExecution {
  const definition = options.definition ?? classifierDefinition();
  const status = options.classifyStatus ?? "completed";
  return createWorkflowExecution({
    status: "running",
    workingDefinition: definition,
    contextStates: options.contextStates ?? {
      classify:
        status === "completed"
          ? landedSource("classify")
          : contextState("classify", { status }),
      fix: contextState("fix"),
      ship: contextState("ship"),
      report: contextState("report"),
    },
    taskStates: Object.fromEntries(
      definition.tasks.map((task) => [
        task.id,
        {
          taskId: task.id,
          contextId: task.contextId,
          order: task.order,
          // Coherent with the context state above: a completed context whose
          // tasks still read pending is not a state the engine can produce, and
          // the live-edit gate refuses to reason about one.
          status:
            status === "completed" && task.contextId === "classify"
              ? ("completed" as const)
              : ("pending" as const),
          summary: null,
          startedAt: null,
          completedAt: null,
          lastConversationId: null,
          failureMessage: null,
          failureHistory: [],
        },
      ]),
    ),
    contextOutputs:
      options.verdict === undefined
        ? {}
        : {
            classify: {
              value: { verdict: options.verdict },
              capturedAt: NOW,
              iteration: 1,
              parse: { source: "native" },
            },
          },
  });
}

describe("projectExecutionRoutes", () => {
  it("resolves guards over the running execution's captured outputs", () => {
    const projection = projectExecutionRoutes(
      classifierExecution({ verdict: "fix" }),
    );

    expect(
      projection.edges.find((edge) => edge.edgeId === "classify__fix")
        ?.resolution,
    ).toEqual({ kind: "active" });
    expect(
      projection.edges.find((edge) => edge.edgeId === "classify__ship")
        ?.resolution,
    ).toEqual({ kind: "inactive" });
  });
});

describe("isRouteSourceLanded (R2.5 land gate)", () => {
  it("is false while a completed source's fan-in merge is pending, and true once merged", () => {
    const pending = classifierExecution({
      verdict: "fix",
      contextStates: {
        classify: landedSource("classify", {
          isolation: "worktree",
          mergeStatus: "pending",
        }),
        fix: contextState("fix"),
        ship: contextState("ship"),
        report: contextState("report"),
      },
    });
    expect(isRouteSourceLanded(pending, "classify")).toBe(false);

    const merged = structuredClone(pending);
    merged.contextStates.classify!.mergeStatus = "merged-success";
    expect(isRouteSourceLanded(merged, "classify")).toBe(true);
  });

  it("treats only a reconciled landing as landed, whatever the lifecycle says (decision D8)", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify!.landingIntent = {
      mode: "solo_commit",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: null,
      worktreePath: null,
      baselineSha: "aaa",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    };
    // Once an intent exists it IS the landing record. Lifecycle bookkeeping
    // says the commit phase was ENTERED, not that it produced a landing, so a
    // pending intent blocks exactly as a failed one does.
    expect(isRouteSourceLanded(execution, "classify")).toBe(false);

    const failed = structuredClone(execution);
    failed.contextStates.classify!.landingIntent = {
      ...failed.contextStates.classify!.landingIntent!,
      state: "failed",
      evidence: "commit",
      settledAt: NOW,
    };
    expect(isRouteSourceLanded(failed, "classify")).toBe(false);

    const landed = structuredClone(execution);
    landed.contextStates.classify!.landingIntent = {
      ...landed.contextStates.classify!.landingIntent!,
      state: "landed",
      evidence: "commit",
      settledAt: NOW,
    };
    expect(isRouteSourceLanded(landed, "classify")).toBe(true);
  });

  it("falls back to the commit evidence for a pre-D8 context that never recorded an intent", () => {
    const execution = classifierExecution({ verdict: "fix" });
    expect(execution.contextStates.classify?.landingIntent).toBeNull();
    expect(isRouteSourceLanded(execution, "classify")).toBe(true);
  });

  it("treats a skipped source as landed — it owes nothing to land", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.ship = contextState("ship", {
      status: "skipped",
      skipReason: { edgeEvaluations: [], at: NOW },
    });
    expect(isRouteSourceLanded(execution, "ship")).toBe(true);
  });
});

describe("settleRoutes — skips (R4.1) and the land gate (R2.5)", () => {
  it("skips the branch the guard rejected and records the complete verdict set", () => {
    const execution = classifierExecution({ verdict: "fix" });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.halt).toBeNull();
    expect(outcome.skippedContextIds).toEqual(["ship"]);
    expect(execution.contextStates.ship?.status).toBe("skipped");
    expect(execution.contextStates.ship?.skipReason).toEqual({
      edgeEvaluations: [{ edgeId: "classify__ship", verdict: "inactive" }],
      at: NOW,
    });
    expect(execution.contextStates.fix?.status).toBe("pending");
  });

  it("ripples the skip through an unconditional descendant only when every path is skipped", () => {
    const execution = classifierExecution({ verdict: "fix" });
    settleRoutes(execution, { now: NOW });
    // `report` fans in from both branches: one omitted, one active — it runs.
    expect(execution.contextStates.report?.status).toBe("pending");

    const bothSkipped = classifierExecution({ verdict: "neither" });
    settleRoutes(bothSkipped, { now: NOW });
    expect(bothSkipped.contextStates.fix?.status).toBe("skipped");
    expect(bothSkipped.contextStates.ship?.status).toBe("skipped");
    expect(bothSkipped.contextStates.report?.status).toBe("skipped");
  });

  it("blocks — never skips — while the completed source's work has not landed", () => {
    const execution = classifierExecution({
      verdict: "fix",
      contextStates: {
        classify: landedSource("classify", {
          isolation: "worktree",
          mergeStatus: "pending",
        }),
        fix: contextState("fix"),
        ship: contextState("ship"),
        report: contextState("report"),
      },
    });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.skippedContextIds).toEqual([]);
    expect(execution.contextStates.ship?.status).toBe("pending");
    expect(execution.routeSettlements).toEqual({});
  });

  it("leaves the route unresolved while the source holds a capture but is not completed (R2.2)", () => {
    const execution = classifierExecution({
      verdict: "ship",
      classifyStatus: "awaiting_approval",
    });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.halt).toBeNull();
    expect(outcome.skippedContextIds).toEqual([]);
    expect(execution.contextStates.fix?.status).toBe("pending");
    expect(execution.routeSettlements).toEqual({});
  });

  it("re-opens the route when an approval rejection deletes the capture (R2.2)", () => {
    const parked = classifierExecution({
      verdict: "ship",
      classifyStatus: "awaiting_approval",
    });
    settleRoutes(parked, { now: NOW });

    // Rejection removes the capture and returns the context to work.
    const rejected = structuredClone(parked);
    rejected.contextOutputs = {};
    rejected.contextStates.classify!.status = "running";
    settleRoutes(rejected, { now: NOW });

    expect(rejected.contextStates.fix?.status).toBe("pending");
    expect(rejected.contextStates.ship?.status).toBe("pending");
  });
});

describe("settleRoutes — landing intents gate the decision (R2.5)", () => {
  it("reconciles the source's intent before recording any skip", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify = landedSource("classify", {
      isolation: "worktree",
      mergeStatus: "merged-success",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:classify:1",
        laneId: null,
        worktreePath: "/tmp/classify",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });

    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.reconciledContextIds).toEqual(["classify"]);
    expect(execution.contextStates.classify?.landingIntent?.state).toBe(
      "landed",
    );
    expect(execution.contextStates.ship?.status).toBe("skipped");
  });

  it("routes nothing while a commit-mode intent has no branch evidence, and settles once the probe supplies it", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify!.landingIntent = {
      mode: "solo_commit",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: null,
      worktreePath: "/tmp/session",
      baselineSha: "aaa",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    };

    // No branch facts: the landing is unproven, so nothing routes. Deciding
    // here is exactly the guess decision D8 removes — after a restart that
    // found no replay evidence, resume would otherwise route anyway.
    const blocked = settleRoutes(execution, { now: NOW });

    expect(blocked.reconciledContextIds).toEqual([]);
    expect(blocked.skippedContextIds).toEqual([]);
    expect(execution.contextStates.classify?.landingIntent?.state).toBe(
      "pending",
    );
    expect(execution.contextStates.ship?.status).toBe("pending");
    expect(execution.routeSettlements).toEqual({});

    // The probe finds the deterministic trailer on the branch: replayable
    // evidence, so the intent lands and the routing follows in the same pass.
    const settled = settleRoutes(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "classify",
          { headSha: "bbb", tokenCommitSha: "bbb", baselineReachable: true },
        ],
      ]),
    });

    expect(settled.reconciledContextIds).toEqual(["classify"]);
    expect(execution.contextStates.classify?.landingIntent?.state).toBe(
      "landed",
    );
    expect(settled.skippedContextIds).toEqual(["ship"]);
    expect(execution.routeSettlements.classify?.settledAt).toBe(LATER);
  });

  it("collects the commit repair for a completed context whose commit never ran", () => {
    // The crash window a probe cannot fix (D4 R9.4): the context completed and
    // the process died BEFORE the commit, so there is nothing on the branch to
    // reconcile. Its dependents — and any loop settling on it — block forever
    // unless the commit is re-run on resume.
    const execution = classifierExecution({ verdict: "fix" });
    const classify = execution.contextStates.classify;
    if (!classify) throw new Error("missing classify state");
    classify.landingIntent = {
      mode: "lane_commit",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: "lane-classify",
      worktreePath: "/tmp/stale-at-dispatch",
      baselineSha: "aaa",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    };
    classify.laneId = "lane-classify";
    execution.executionLanes["lane-classify"] = {
      laneId: "lane-classify",
      kind: "worktree",
      status: "active",
      worktreePath: "/tmp/lane-classify",
      branchName: "csm/lane-classify",
      includedContextIds: [],
      lastCommittingContextId: null,
      commitSnapshots: [],
      createdAt: NOW,
      updatedAt: NOW,
    };

    // The LANE record wins over the intent's dispatch-time copy: it is where
    // the branch lives now.
    expect(collectLandingCommitRepairs(execution)).toEqual([
      {
        contextId: "classify",
        mode: "lane_commit",
        laneId: "lane-classify",
        worktreePath: "/tmp/lane-classify",
        branchName: "csm/lane-classify",
        baselineSha: "aaa",
      },
    ]);

    // A landed intent is settled history; a failed one already halted and is
    // the operator's to resume; a fan-in landing is the join's business, not a
    // commit's; and a landing cannot precede the work it lands.
    for (const mutate of [
      (state: GraphWorkflowExecutionContextState) => {
        if (state.landingIntent) state.landingIntent.state = "landed";
      },
      (state: GraphWorkflowExecutionContextState) => {
        if (state.landingIntent) state.landingIntent.state = "failed";
      },
      (state: GraphWorkflowExecutionContextState) => {
        if (state.landingIntent) state.landingIntent.mode = "fan_in_merge";
      },
      (state: GraphWorkflowExecutionContextState) => {
        state.status = "running";
      },
      (state: GraphWorkflowExecutionContextState) => {
        state.landingIntent = null;
      },
    ]) {
      const variant = structuredClone(execution);
      const state = variant.contextStates.classify;
      if (!state) throw new Error("missing classify state");
      mutate(state);
      expect(collectLandingCommitRepairs(variant)).toEqual([]);
    }

    // No worktree to commit in: nothing to repair, and never a throw.
    const orphaned = structuredClone(execution);
    delete orphaned.executionLanes["lane-classify"];
    const orphanedState = orphaned.contextStates.classify;
    if (!orphanedState?.landingIntent) throw new Error("missing intent");
    orphanedState.landingIntent.worktreePath = null;
    orphanedState.worktreePath = null;
    expect(collectLandingCommitRepairs(orphaned)).toEqual([]);
  });

  it("collects the probe target for a completed context whose commit-mode intent is unsettled", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify!.landingIntent = {
      mode: "solo_commit",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: null,
      worktreePath: "/tmp/session",
      baselineSha: "aaa",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    };

    expect(collectLandingProbeTargets(execution)).toEqual([
      {
        contextId: "classify",
        token: "cc-landing:execution-1:classify:1",
        worktreePath: "/tmp/session",
        baselineSha: "aaa",
      },
    ]);

    // A context still running cannot have landed, so probing its branch would
    // buy nothing — and the per-pass probe must stay free in steady state.
    const running = structuredClone(execution);
    running.contextStates.classify!.status = "running";
    expect(collectLandingProbeTargets(running)).toEqual([]);
  });

  it("blocks the branch decision while the source's landing failed", () => {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify!.landingIntent = {
      mode: "fan_in_merge",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: null,
      worktreePath: "/tmp/classify",
      baselineSha: "aaa",
      headSha: null,
      joinId: "join-1",
      state: "failed",
      evidence: "join-merge",
      recordedAt: NOW,
      settledAt: NOW,
    };

    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.skippedContextIds).toEqual([]);
    expect(execution.contextStates.ship?.status).toBe("pending");
    expect(execution.routeSettlements).toEqual({});
  });
});

describe("merge-retry recovery, through the scheduler (R2.5)", () => {
  /** A classifier whose fan-in merge failed: its verdict is banked, its work is not. */
  function mergeFailedClassifier(): GraphWorkflowExecution {
    const execution = classifierExecution({ verdict: "fix" });
    execution.contextStates.classify = landedSource("classify", {
      isolation: "worktree",
      worktreePath: "/tmp/classify",
      branchName: "csm/classify",
      mergeStatus: "merged-failed",
      lastMergeError: "conflict in src/app.ts",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:classify:1",
        laneId: null,
        worktreePath: "/tmp/classify",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });
    execution.pendingMergeRetry = ["classify"];
    return execution;
  }

  it("blocks both branches while the merge is unresolved, then releases them when the retry lands", () => {
    const execution = mergeFailedClassifier();

    const blocked = settleRoutes(execution, { now: NOW });
    expect(blocked.halt).toBeNull();
    expect(blocked.skippedContextIds).toEqual([]);
    expect(execution.contextStates.classify?.landingIntent?.state).toBe(
      "failed",
    );
    // Guard truth is not enough: neither the taken branch nor the declined one
    // moves while the source's work has not landed.
    expect(
      getEligibleContextIds(execution.workingDefinition, execution),
    ).toEqual([]);
    expect(execution.contextStates.ship?.status).toBe("pending");

    // What a successful `processPendingMergeRetry` leaves behind.
    execution.contextStates.classify!.mergeStatus = "merged-success";
    execution.contextStates.classify!.lastMergeError = null;
    execution.pendingMergeRetry = [];

    const released = settleRoutes(execution, { now: LATER });
    expect(released.reconciledContextIds).toEqual(["classify"]);
    expect(execution.contextStates.classify?.landingIntent?.state).toBe(
      "landed",
    );
    expect(execution.contextStates.ship?.status).toBe("skipped");
    expect(
      getEligibleContextIds(execution.workingDefinition, execution),
    ).toEqual(["fix"]);
  });
});

describe("settleRoutes — route settlements (decision D4)", () => {
  it("writes one bounded settlement per source, exactly once per dedup key", () => {
    const execution = classifierExecution({ verdict: "fix" });
    const first = settleRoutes(execution, { now: NOW });

    expect(first.settledSourceContextIds).toEqual(["classify"]);
    expect(execution.routeSettlements.classify).toEqual({
      sourceContextId: "classify",
      effectiveSourceContextId: "classify",
      edgeEvaluations: [
        { edgeId: "classify__fix", verdict: "active" },
        { edgeId: "classify__ship", verdict: "inactive" },
      ],
      captureIteration: 1,
      routeControlRevision: 0,
      activatedEdgeIds: ["classify__fix"],
      inactiveEdgeIds: ["classify__ship"],
      omittedEdgeIds: [],
      settledAt: NOW,
    });

    const second = settleRoutes(execution, { now: "2026-08-04T11:00:00.000Z" });
    expect(second.settledSourceContextIds).toEqual([]);
    expect(execution.routeSettlements.classify?.settledAt).toBe(NOW);
  });

  it("re-settles the same capture under a bumped route-control revision", () => {
    const execution = classifierExecution({ verdict: "fix" });
    settleRoutes(execution, { now: NOW });
    execution.routeControlRevisions = { classify: 1 };

    const again = settleRoutes(execution, { now: "2026-08-04T12:00:00.000Z" });
    expect(again.settledSourceContextIds).toEqual(["classify"]);
    expect(execution.routeSettlements.classify?.routeControlRevision).toBe(1);
  });
});

describe("settleRoutes — typed resumable halts", () => {
  it("halts on a completed conditional source with no readable output (R2.4)", () => {
    const execution = classifierExecution({ classifyStatus: "completed" });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.halt).toMatchObject({
      type: "routing_invariant",
      reason: "guard-unevaluable",
      sourceContextIds: ["classify"],
    });
    expect(outcome.skippedContextIds).toEqual([]);
    expect(execution.contextStates.fix?.status).toBe("pending");
  });

  it("halts on under-selection under atLeastOne (R3.1)", () => {
    const definition = classifierDefinition();
    const withPolicy: ResolvedWorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "classify"
          ? { ...context, routing: { cardinality: "atLeastOne" as const } }
          : context,
      ),
    };
    const execution = classifierExecution({
      verdict: "neither",
      definition: withPolicy,
    });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.halt).toMatchObject({
      type: "routing_cardinality",
      contextId: "classify",
      policy: "atLeastOne",
      outcome: "under-selection",
      activatedEdgeIds: [],
    });
  });

  it("halts on over-selection under exactlyOne and records the evaluated verdicts (R3.1)", () => {
    const definition = classifierDefinition([
      {},
      {
        when: {
          schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      },
    ]);
    const withPolicy: ResolvedWorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "classify"
          ? { ...context, routing: { cardinality: "exactlyOne" as const } }
          : context,
      ),
    };
    const execution = classifierExecution({
      verdict: "fix",
      definition: withPolicy,
    });
    const outcome = settleRoutes(execution, { now: NOW });

    expect(outcome.halt).toMatchObject({
      type: "routing_cardinality",
      policy: "exactlyOne",
      outcome: "over-selection",
      activatedEdgeIds: ["classify__fix", "classify__ship"],
    });
    // A halted routing decision applies nothing.
    expect(execution.contextStates.ship?.status).toBe("pending");
  });

  it("halts on zero matches under exactlyOne (R3.1)", () => {
    const definition = classifierDefinition();
    const withPolicy: ResolvedWorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "classify"
          ? { ...context, routing: { cardinality: "exactlyOne" as const } }
          : context,
      ),
    };
    const execution = classifierExecution({
      verdict: "neither",
      definition: withPolicy,
    });

    expect(settleRoutes(execution, { now: NOW }).halt).toMatchObject({
      type: "routing_cardinality",
      outcome: "under-selection",
    });
  });
});

describe("landing intents (decision D8)", () => {
  it("records a pending intent with a deterministic token at dispatch", () => {
    const execution = classifierExecution({});
    const intent = recordLandingIntent(execution, "fix", {
      mode: "lane_commit",
      laneId: "lane-1",
      worktreePath: "/tmp/lane-1",
      baselineSha: "aaa",
      now: NOW,
    });

    expect(intent).toEqual({
      mode: "lane_commit",
      attempt: 1,
      token: "cc-landing:execution-1:fix:1",
      laneId: "lane-1",
      worktreePath: "/tmp/lane-1",
      baselineSha: "aaa",
      headSha: null,
      joinId: null,
      state: "pending",
      evidence: null,
      recordedAt: NOW,
      settledAt: null,
    });
    expect(execution.contextStates.fix?.landingIntent).toEqual(intent);

    const second = recordLandingIntent(execution, "fix", {
      mode: "lane_commit",
      laneId: "lane-1",
      worktreePath: "/tmp/lane-1",
      baselineSha: "bbb",
      now: NOW,
    });
    expect(second.attempt).toBe(2);
    expect(second.token).toBe("cc-landing:execution-1:fix:2");
  });

  it("settles an intent with its landing evidence", () => {
    const execution = classifierExecution({});
    recordLandingIntent(execution, "fix", {
      mode: "lane_commit",
      laneId: "lane-1",
      worktreePath: "/tmp/lane-1",
      baselineSha: "aaa",
      now: NOW,
    });
    settleLandingIntent(execution, "fix", {
      state: "landed",
      evidence: "adopted-head",
      headSha: "bbb",
      now: NOW,
    });

    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "adopted-head",
      baselineSha: "aaa",
      headSha: "bbb",
      settledAt: NOW,
    });
  });

  it("reconciles a pending intent at resume from the durable commit evidence", () => {
    const execution = classifierExecution({});
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      mergeStatus: "merged-success",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: null,
        worktreePath: "/tmp/fix",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });

    const reconciled = reconcileLandingIntents(execution, { now: NOW });
    expect(reconciled).toEqual(["fix"]);
    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "join-merge",
    });
  });

  it("reconciles a fan-in intent against the join's own record, not the context's projection of it", () => {
    const execution = classifierExecution({});
    execution.joins = {
      "join-1": {
        joinId: "join-1",
        kind: "context_merge",
        contextId: "fix",
        targetLaneId: "lane-a",
        sourceLaneIds: ["lane-a", "lane-b"],
        mergedSourceLaneIds: [],
        validationDebtSourceLaneIds: [],
        status: "failed",
        errorMessage: "conflict in src/app.ts",
        conflicts: null,
        conflictGuidance: null,
        createdAt: NOW,
        updatedAt: NOW,
        completedAt: null,
      },
    };
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      // The context's own merge status still reads clean — a crash between the
      // join failing and the projection catching up. The join record decides.
      mergeStatus: "merged-success",
      joinId: "join-1",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: null,
        worktreePath: "/tmp/fix",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });

    reconcileLandingIntents(execution, { now: NOW });

    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "failed",
      evidence: "join-merge",
      joinId: "join-1",
    });
    expect(isRouteSourceLanded(execution, "fix")).toBe(false);
  });

  it("reconciles a failed fan-in merge to a blocking failed intent", () => {
    const execution = classifierExecution({});
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      mergeStatus: "merged-failed",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: null,
        worktreePath: "/tmp/fix",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });

    reconcileLandingIntents(execution, { now: NOW });
    expect(execution.contextStates.fix?.landingIntent?.state).toBe("failed");
    expect(isRouteSourceLanded(execution, "fix")).toBe(false);
  });

  it("re-lands a failed fan-in intent once the merge retry succeeds (R2.5)", () => {
    const execution = classifierExecution({});
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      mergeStatus: "merged-failed",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: null,
        worktreePath: "/tmp/fix",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });
    reconcileLandingIntents(execution, { now: NOW });
    expect(isRouteSourceLanded(execution, "fix")).toBe(false);

    // What `processPendingMergeRetry` leaves behind when the retry succeeds:
    // the merge status moves and nothing else. Reconciliation has to notice,
    // or the dependents stay blocked on a merge that already landed.
    execution.contextStates.fix!.mergeStatus = "merged-success";

    const reconciled = reconcileLandingIntents(execution, { now: LATER });
    expect(reconciled).toEqual(["fix"]);
    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "join-merge",
      settledAt: LATER,
    });
    expect(isRouteSourceLanded(execution, "fix")).toBe(true);
  });

  it("reports a reconciliation only when the intent's state actually moves", () => {
    const execution = classifierExecution({});
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      mergeStatus: "merged-failed",
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: null,
        worktreePath: "/tmp/fix",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });

    expect(reconcileLandingIntents(execution, { now: NOW })).toEqual(["fix"]);
    // Still failed on the next pass: no move, no re-write, no re-report — the
    // settlement pass runs every tick and must not churn the blob.
    expect(reconcileLandingIntents(execution, { now: LATER })).toEqual([]);
    expect(execution.contextStates.fix?.landingIntent?.settledAt).toBe(NOW);
  });
});

describe("landing evidence (decision D8): commit modes replay from the branch", () => {
  /** A lane-committed context: completed, lane-bound, recorded in the lane. */
  function laneCommitExecution(
    intentOverrides: Partial<
      NonNullable<GraphWorkflowExecutionContextState["landingIntent"]>
    > = {},
  ): GraphWorkflowExecution {
    const execution = classifierExecution({});
    execution.executionLanes = {
      "lane-1": {
        laneId: "lane-1",
        kind: "worktree",
        status: "active",
        branchName: "csm/lane-1",
        worktreePath: "/tmp/lane-1",
        includedContextIds: ["fix"],
        lastCommittingContextId: "fix",
        commitSnapshots: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    };
    execution.contextStates.fix = landedSource("fix", {
      isolation: "worktree",
      laneId: "lane-1",
      worktreePath: "/tmp/lane-1",
      landingIntent: {
        mode: "lane_commit",
        attempt: 1,
        token: "cc-landing:execution-1:fix:1",
        laneId: "lane-1",
        worktreePath: "/tmp/lane-1",
        baselineSha: "aaa",
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
        ...intentOverrides,
      },
    });
    return execution;
  }

  it("refuses to promote a lane commit with no replayable branch evidence", () => {
    const execution = laneCommitExecution();

    // The lane's `includedContextIds` alone is lifecycle bookkeeping, not
    // landing evidence: a crash mid-commit can leave it set. Without the
    // mode-specific replay the intent stays pending.
    expect(reconcileLandingIntents(execution, { now: NOW })).toEqual([]);
    expect(execution.contextStates.fix?.landingIntent?.state).toBe("pending");
  });

  it("promotes a lane commit whose branch carries the landing token", () => {
    const execution = laneCommitExecution();

    const reconciled = reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "ccc", tokenCommitSha: "ccc", baselineReachable: true },
        ],
      ]),
    });

    expect(reconciled).toEqual(["fix"]);
    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "commit",
      headSha: "ccc",
    });
  });

  it("promotes a self-authored commit adopted in the recorded baseline→head range", () => {
    const execution = laneCommitExecution();

    reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "bbb", tokenCommitSha: null, baselineReachable: true },
        ],
      ]),
    });

    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "adopted-head",
      headSha: "bbb",
    });
  });

  it("refuses to adopt a moved lane HEAD for an enveloped context, because on a shared lane the mover is a sibling", () => {
    const execution = laneCommitExecution();
    const state = execution.contextStates.fix;
    if (!state) throw new Error("fixture missing the fix context state");
    state.reservedOwnership = {
      mode: "owned",
      canonicalPrefixes: ["/tmp/lane-1/src/api"],
    };

    // HEAD moved past the baseline with no trailer for this context: a sibling
    // member landed. Crediting the range would settle this context as landed
    // over work that was never committed, and its own landing would never be
    // repaired — the commit would be silently lost.
    expect(
      reconcileLandingIntents(execution, {
        now: LATER,
        branchEvidence: new Map([
          [
            "fix",
            { headSha: "bbb", tokenCommitSha: null, baselineReachable: true },
          ],
        ]),
      }),
    ).toEqual([]);
    expect(execution.contextStates.fix?.landingIntent?.state).toBe("pending");
  });

  it("still promotes an enveloped context on its own trailer, which is the only evidence that names it", () => {
    const execution = laneCommitExecution();
    const state = execution.contextStates.fix;
    if (!state) throw new Error("fixture missing the fix context state");
    state.reservedOwnership = {
      mode: "owned",
      canonicalPrefixes: ["/tmp/lane-1/src/api"],
    };

    reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "ccc", tokenCommitSha: "bbb", baselineReachable: true },
        ],
      ]),
    });

    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "commit",
      headSha: "ccc",
    });
  });

  it("refuses to adopt a moved lane HEAD for a read-only member, which commits nothing of its own", () => {
    const execution = laneCommitExecution();
    const state = execution.contextStates.fix;
    if (!state) throw new Error("fixture missing the fix context state");
    state.reservedOwnership = { mode: "readOnly", canonicalPrefixes: [] };

    expect(
      reconcileLandingIntents(execution, {
        now: LATER,
        branchEvidence: new Map([
          [
            "fix",
            { headSha: "bbb", tokenCommitSha: null, baselineReachable: true },
          ],
        ]),
      }),
    ).toEqual([]);
    expect(execution.contextStates.fix?.landingIntent?.state).toBe("pending");
  });

  it("refuses an adopted range whose recorded baseline is not an ancestor of head", () => {
    const execution = laneCommitExecution();

    // The lane was rewritten or the baseline belongs to another attempt: the
    // range proves nothing about this context's work.
    reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "bbb", tokenCommitSha: null, baselineReachable: false },
        ],
      ]),
    });

    expect(execution.contextStates.fix?.landingIntent?.state).toBe("pending");
  });

  it("promotes a no-changes landing whose recorded range is empty", () => {
    const execution = laneCommitExecution();

    reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "aaa", tokenCommitSha: null, baselineReachable: true },
        ],
      ]),
    });

    expect(execution.contextStates.fix?.landingIntent).toMatchObject({
      state: "landed",
      evidence: "no-changes",
    });
  });

  it("refuses to verify a range it never recorded a baseline for", () => {
    const execution = laneCommitExecution({ baselineSha: null });

    reconcileLandingIntents(execution, {
      now: LATER,
      branchEvidence: new Map([
        [
          "fix",
          { headSha: "bbb", tokenCommitSha: null, baselineReachable: false },
        ],
      ]),
    });

    expect(execution.contextStates.fix?.landingIntent?.state).toBe("pending");
  });

  it("collects a probe target for every unlanded commit-mode intent", () => {
    const execution = laneCommitExecution();
    execution.contextStates.ship = landedSource("ship", {
      landingIntent: {
        mode: "solo_commit",
        attempt: 2,
        token: "cc-landing:execution-1:ship:2",
        laneId: null,
        worktreePath: "/tmp/session",
        baselineSha: "ddd",
        headSha: null,
        joinId: null,
        state: "failed",
        evidence: "commit",
        recordedAt: NOW,
        settledAt: NOW,
      },
    });
    // A fan-in intent reconciles against the join record, and a landed one is
    // settled history: neither is worth a git probe.
    execution.contextStates.report = landedSource("report", {
      landingIntent: {
        mode: "fan_in_merge",
        attempt: 1,
        token: "cc-landing:execution-1:report:1",
        laneId: null,
        worktreePath: "/tmp/report",
        baselineSha: null,
        headSha: null,
        joinId: null,
        state: "pending",
        evidence: null,
        recordedAt: NOW,
        settledAt: null,
      },
    });
    execution.contextStates.classify!.landingIntent = {
      mode: "solo_commit",
      attempt: 1,
      token: "cc-landing:execution-1:classify:1",
      laneId: null,
      worktreePath: "/tmp/session",
      baselineSha: "eee",
      headSha: "fff",
      joinId: null,
      state: "landed",
      evidence: "commit",
      recordedAt: NOW,
      settledAt: NOW,
    };

    expect(collectLandingProbeTargets(execution)).toEqual([
      {
        contextId: "fix",
        token: "cc-landing:execution-1:fix:1",
        worktreePath: "/tmp/lane-1",
        baselineSha: "aaa",
      },
      {
        contextId: "ship",
        token: "cc-landing:execution-1:ship:2",
        worktreePath: "/tmp/session",
        baselineSha: "ddd",
      },
    ]);
  });
});

describe("the sanctioned remedy: a quiescent edge edit, then resume", () => {
  const LIVE_EDIT_DEPS: LiveEditDeps = {
    createTaskId: () => "task-minted-1",
    resolvedGlobalDefaults() {
      throw new Error("edge updates do not resolve context defaults");
    },
    validationCommandPreflight() {
      throw new Error("edge updates do not edit validation selections");
    },
    snapshotFor() {
      throw new Error("edge updates do not introduce assignments");
    },
    now: () => NOW,
  };

  /**
   * R2.4's remedy in full: the halt is raised, the operator amends the guard on
   * the UNSTARTED target's incoming edge while the execution is quiescent, and
   * the next settlement pass routes. The completed source is never edited and
   * the guard is never evaluated as false in between.
   */
  it("clears a guard-unevaluable halt without touching the completed source", () => {
    const halted = classifierExecution({ classifyStatus: "completed" });
    const invariantHalt = settleRoutes(halted, { now: NOW }).halt;
    expect(invariantHalt).toMatchObject({ type: "routing_invariant" });
    // The execution as the operator finds it: halted on the routing invariant,
    // quiescent, and therefore open to a structural edit.
    halted.status = "halted";
    halted.haltReason = invariantHalt;

    const edited = applyLiveExecutionEdits(
      halted,
      {
        operations: [
          { type: "update-edge", edgeId: "classify__fix", when: null },
          { type: "update-edge", edgeId: "classify__ship", when: null },
        ],
      },
      LIVE_EDIT_DEPS,
    );
    if (!edited.ok) {
      throw new Error(`${edited.code}: ${JSON.stringify(edited.issues)}`);
    }

    const resumed = settleRoutes(edited.execution, { now: NOW });
    expect(resumed.halt).toBeNull();
    // The completed source kept its status and its (unreadable) capture: the
    // remedy edits the ROUTE, never the context that already ran.
    expect(edited.execution.contextStates.classify?.status).toBe("completed");
    expect(edited.execution.contextStates.fix?.status).toBe("pending");
    expect(edited.execution.contextStates.ship?.status).toBe("pending");
  });

  /**
   * R3.1's remedy: over-selection is cleared by narrowing the guard set, not by
   * re-running the classifier.
   */
  it("clears a cardinality halt once the guard set stops over-selecting", () => {
    const definition = classifierDefinition([
      {},
      {
        when: {
          schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      },
    ]);
    const withPolicy: ResolvedWorkflowSemanticDefinition = {
      ...definition,
      executionContexts: definition.executionContexts.map((context) =>
        context.id === "classify"
          ? { ...context, routing: { cardinality: "exactlyOne" as const } }
          : context,
      ),
    };
    const halted = classifierExecution({
      verdict: "fix",
      definition: withPolicy,
    });
    const cardinalityHalt = settleRoutes(halted, { now: NOW }).halt;
    expect(cardinalityHalt).toMatchObject({
      type: "routing_cardinality",
      outcome: "over-selection",
    });
    halted.status = "halted";
    halted.haltReason = cardinalityHalt;

    const edited = applyLiveExecutionEdits(
      halted,
      { operations: [{ type: "remove-edge", edgeId: "classify__ship" }] },
      LIVE_EDIT_DEPS,
    );
    if (!edited.ok) {
      throw new Error(`${edited.code}: ${JSON.stringify(edited.issues)}`);
    }

    expect(settleRoutes(edited.execution, { now: NOW }).halt).toBeNull();
    expect(edited.execution.contextStates.fix?.status).toBe("pending");
  });
});
