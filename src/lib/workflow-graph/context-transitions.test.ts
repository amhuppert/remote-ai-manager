import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  CONTEXT_STATUS_TRANSITIONS,
  IllegalContextStatusTransitionError,
  applyJoinProgress,
  buildLifecycleSnapshot,
  isLegalContextStatusTransition,
  resetContextStateToInitial,
  resetJoinForRetry,
  resetRunningJoinsToPending,
  skipContext,
  transitionContextMergeStatus,
  transitionContextStatus,
} from "./context-transitions";
import { createWorkflowExecution } from "./test-fixtures";
import type { RouteEdgeEvaluation } from "./route-projection";
import {
  graphWorkflowContextSkipReasonSchema,
  type GraphWorkflowContextSkipReason,
  type GraphWorkflowExecutionJoinState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowContextStatus } from "@/lib/workflow-graph/definition-schemas";

const ALL_STATUSES: GraphWorkflowContextStatus[] = [
  "pending",
  "ready",
  "running",
  "completed",
  "halted",
  "awaiting_approval",
  "awaiting_user_input",
  "skipped",
];

function buildJoin(
  overrides: Partial<GraphWorkflowExecutionJoinState> = {},
): GraphWorkflowExecutionJoinState {
  return {
    joinId: "join-1",
    kind: "context_merge",
    contextId: "context-implement",
    targetLaneId: "lane-a",
    sourceLaneIds: ["lane-a", "lane-b"],
    mergedSourceLaneIds: [],
    validationDebtSourceLaneIds: [],
    status: "pending",
    errorMessage: null,
    conflicts: null,
    conflictGuidance: null,
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("CONTEXT_STATUS_TRANSITIONS legality table", () => {
  const expectedTable: Record<
    GraphWorkflowContextStatus,
    GraphWorkflowContextStatus[]
  > = {
    // A route verdict can only skip a context that has not started (D4 R4):
    // once a context is running it has a lane, a conversation and work on
    // disk, none of which a skip may discard.
    pending: ["ready", "running", "halted", "skipped"],
    ready: ["running", "halted", "skipped"],
    running: [
      "ready",
      "completed",
      "halted",
      "awaiting_approval",
      "awaiting_user_input",
    ],
    // `ready` returns an abandoned park to the schedulable set — the approval
    // that can no longer complete its context (its output contract changed
    // under the park) leaves no runner behind.
    awaiting_approval: ["ready", "running", "completed", "halted"],
    // `ready` likewise returns an abandoned user-input park: pause-to-edit
    // withdraws the round's parked validator questions, so nothing is waiting
    // on the human and the context owes the edited roster a fresh round.
    awaiting_user_input: ["ready", "running", "halted"],
    halted: [
      "ready",
      "running",
      "completed",
      "awaiting_approval",
      "awaiting_user_input",
    ],
    completed: [],
    skipped: [],
  };

  it("covers every context status as a source", () => {
    expect(Object.keys(CONTEXT_STATUS_TRANSITIONS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });

  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const legal = from === to || expectedTable[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "legal" : "illegal"}`, () => {
        expect(isLegalContextStatusTransition(from, to)).toBe(legal);
      });
    }
  }

  it("completed is terminal (no outgoing transitions)", () => {
    expect(CONTEXT_STATUS_TRANSITIONS.completed).toEqual([]);
  });

  it("skipped is terminal (no outgoing transitions)", () => {
    expect(CONTEXT_STATUS_TRANSITIONS.skipped).toEqual([]);
  });
});

describe("skipContext (D4 R4.2)", () => {
  // The projection computes the verdicts and this schema persists them. They
  // are spelled in two modules on purpose (the projection stays structural and
  // browser-safe), so the assignment below is the pin that keeps them one shape:
  // it stops compiling the moment either side gains or renames a field.
  it("persists exactly the shape the route projection produces", () => {
    const fromProjection: RouteEdgeEvaluation = {
      edgeId: "edge-plan-implement",
      verdict: "inactive",
    };
    const persisted: GraphWorkflowContextSkipReason["edgeEvaluations"][number] =
      fromProjection;

    expect(
      graphWorkflowContextSkipReasonSchema.safeParse({
        edgeEvaluations: [persisted],
        at: "2026-08-04T10:00:00.000Z",
      }).success,
    ).toBe(true);
  });

  const skipReason: GraphWorkflowContextSkipReason = {
    edgeEvaluations: [
      { edgeId: "edge-plan-implement", verdict: "inactive" },
      { edgeId: "edge-design-implement", verdict: "active" },
    ],
    at: "2026-08-04T10:00:00.000Z",
  };

  it("moves an unstarted context to skipped and persists the guard verdicts in the same write", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "ready";

    skipContext(execution, "context-implement", skipReason, {
      reason: "test",
    });

    const contextState = execution.contextStates["context-implement"]!;
    expect(contextState.status).toBe("skipped");
    expect(contextState.skipReason).toEqual(skipReason);
  });

  it("skips a pending context that never became ready", () => {
    const execution = createWorkflowExecution();

    skipContext(execution, "context-implement", skipReason, { reason: "test" });

    expect(execution.contextStates["context-implement"]!.status).toBe(
      "skipped",
    );
  });

  it("refuses a started context and records no skip reason", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "running";

    expect(() =>
      skipContext(execution, "context-implement", skipReason, {
        reason: "test",
      }),
    ).toThrow(IllegalContextStatusTransitionError);
    expect(execution.contextStates["context-implement"]!.status).toBe(
      "running",
    );
    expect(execution.contextStates["context-implement"]!.skipReason).toBeNull();
  });

  it("refuses a completed context (completed stays terminal)", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "completed";

    expect(() =>
      skipContext(execution, "context-implement", skipReason, {
        reason: "test",
      }),
    ).toThrow(IllegalContextStatusTransitionError);
  });

  it("keeps the first recorded reason when a settled skip is re-derived", () => {
    const execution = createWorkflowExecution();
    skipContext(execution, "context-implement", skipReason, { reason: "test" });

    skipContext(
      execution,
      "context-implement",
      {
        edgeEvaluations: [
          { edgeId: "edge-plan-implement", verdict: "omitted" },
        ],
        at: "2026-08-04T11:00:00.000Z",
      },
      { reason: "test" },
    );

    expect(execution.contextStates["context-implement"]!.skipReason).toEqual(
      skipReason,
    );
  });
});

describe("transitionContextStatus", () => {
  it("applies a legal transition", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-plan"]!.status = "running";

    transitionContextStatus(execution, "context-plan", "completed", {
      reason: "test",
    });

    expect(execution.contextStates["context-plan"]!.status).toBe("completed");
  });

  it("treats an identity transition as a no-op", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-plan"]!.status = "completed";

    transitionContextStatus(execution, "context-plan", "completed", {
      reason: "test",
    });

    expect(execution.contextStates["context-plan"]!.status).toBe("completed");
  });

  it("throws IllegalContextStatusTransitionError on an illegal transition and leaves the draft untouched", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-plan"]!.status = "completed";

    expect(() =>
      transitionContextStatus(execution, "context-plan", "running", {
        reason: "test",
      }),
    ).toThrow(IllegalContextStatusTransitionError);
    expect(execution.contextStates["context-plan"]!.status).toBe("completed");
  });

  it("reports from/to/contextId on the error", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-plan"]!.status = "completed";

    try {
      transitionContextStatus(execution, "context-plan", "ready", {
        reason: "test",
      });
      expect.unreachable("expected an illegal-transition throw");
    } catch (error) {
      if (!(error instanceof IllegalContextStatusTransitionError)) throw error;
      expect(error.from).toBe("completed");
      expect(error.to).toBe("ready");
      expect(error.contextId).toBe("context-plan");
    }
  });

  it("throws when the context does not exist", () => {
    const execution = createWorkflowExecution();

    expect(() =>
      transitionContextStatus(execution, "no-such-context", "ready", {
        reason: "test",
      }),
    ).toThrow(/no-such-context/);
  });
});

describe("resetContextStateToInitial", () => {
  it("rebuilds the target entry to the canonical initial state and keeps siblings by reference", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "running";
    execution.contextStates["context-implement"]!.iterationCount = 3;
    execution.contextStates["context-implement"]!.completedTaskCount = 1;

    const next = resetContextStateToInitial(execution, "context-implement", {
      reason: "test",
    });

    expect(next["context-implement"]).toEqual({
      contextId: "context-implement",
      status: "pending",
      totalTaskCount: 1,
      completedTaskCount: 0,
      iterationCount: 0,
      consecutiveFailureCount: 0,
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
    });
    expect(next["context-plan"]).toBe(execution.contextStates["context-plan"]);
    expect(next["context-verify"]).toBe(
      execution.contextStates["context-verify"],
    );
  });

  it("does not mutate the input execution", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "halted";

    resetContextStateToInitial(execution, "context-implement", {
      reason: "test",
    });

    expect(execution.contextStates["context-implement"]!.status).toBe("halted");
  });

  it("rejects a completed context with IllegalContextStatusTransitionError", () => {
    const execution = createWorkflowExecution();
    execution.contextStates["context-implement"]!.status = "completed";

    try {
      resetContextStateToInitial(execution, "context-implement", {
        reason: "test",
      });
      expect.unreachable("expected an illegal-transition throw");
    } catch (error) {
      if (!(error instanceof IllegalContextStatusTransitionError)) throw error;
      expect(error.from).toBe("completed");
      expect(error.to).toBe("pending");
      expect(error.contextId).toBe("context-implement");
    }
  });

  it("rejects a skipped context with IllegalContextStatusTransitionError", () => {
    const execution = createWorkflowExecution();
    skipContext(
      execution,
      "context-implement",
      {
        edgeEvaluations: [
          { edgeId: "edge-plan-implement", verdict: "inactive" },
        ],
        at: "2026-08-04T10:00:00.000Z",
      },
      { reason: "test" },
    );

    try {
      resetContextStateToInitial(execution, "context-implement", {
        reason: "test",
      });
      expect.unreachable("expected an illegal-transition throw");
    } catch (error) {
      if (!(error instanceof IllegalContextStatusTransitionError)) throw error;
      expect(error.from).toBe("skipped");
      expect(error.to).toBe("pending");
      expect(error.contextId).toBe("context-implement");
    }
  });

  it("throws when the context does not exist", () => {
    const execution = createWorkflowExecution();

    expect(() =>
      resetContextStateToInitial(execution, "no-such-context", {
        reason: "test",
      }),
    ).toThrow(/no-such-context/);
  });
});

describe("buildLifecycleSnapshot", () => {
  it("defaults lifecycleStatus to the execution status and recoveryMode to none", () => {
    const execution = createWorkflowExecution({
      status: "running",
      activeContextIds: ["context-plan"],
    });

    expect(
      buildLifecycleSnapshot(execution, { hasLiveIteration: true }),
    ).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "running",
      activeContextId: "context-plan",
      recoveryMode: "none",
      hasLiveIteration: true,
    });
  });

  it("applies explicit lifecycleStatus and recoveryMode overrides", () => {
    const execution = createWorkflowExecution({ status: "running" });

    expect(
      buildLifecycleSnapshot(execution, {
        hasLiveIteration: false,
        lifecycleStatus: "halted",
        recoveryMode: "restart_drain_resumed",
      }),
    ).toEqual({
      schemaVersion: 1,
      lifecycleStatus: "halted",
      activeContextId: null,
      recoveryMode: "restart_drain_resumed",
      hasLiveIteration: false,
    });
  });
});

describe("transitionContextMergeStatus", () => {
  it("applies the merge-status change", () => {
    const execution = createWorkflowExecution();

    transitionContextMergeStatus(execution, "context-plan", "in-progress", {
      reason: "test",
    });

    expect(execution.contextStates["context-plan"]!.mergeStatus).toBe(
      "in-progress",
    );
  });

  it("throws when the context does not exist", () => {
    const execution = createWorkflowExecution();

    expect(() =>
      transitionContextMergeStatus(execution, "no-such-context", "pending", {
        reason: "test",
      }),
    ).toThrow(/no-such-context/);
  });
});

describe("resetRunningJoinsToPending", () => {
  it("resets running joins to pending, stamps updatedAt, and returns their ids", () => {
    const execution = createWorkflowExecution({
      joins: {
        "join-running": buildJoin({
          joinId: "join-running",
          status: "running",
        }),
        "join-failed": buildJoin({ joinId: "join-failed", status: "failed" }),
        "join-succeeded": buildJoin({
          joinId: "join-succeeded",
          status: "succeeded",
        }),
      },
    });

    const resetIds = resetRunningJoinsToPending(
      execution,
      "2026-07-12T12:00:00.000Z",
    );

    expect(resetIds).toEqual(["join-running"]);
    expect(execution.joins["join-running"]!.status).toBe("pending");
    expect(execution.joins["join-running"]!.updatedAt).toBe(
      "2026-07-12T12:00:00.000Z",
    );
    expect(execution.joins["join-failed"]!.status).toBe("failed");
    expect(execution.joins["join-succeeded"]!.status).toBe("succeeded");
  });
});

describe("join transition owners (moved from lane-join)", () => {
  it("applyJoinProgress stamps completedAt on terminal statuses", () => {
    const execution = createWorkflowExecution({
      joins: { "join-1": buildJoin({ status: "running" }) },
    });

    const next = applyJoinProgress(
      execution,
      "join-1",
      "2026-07-12T12:00:00.000Z",
      { status: "succeeded" },
    );

    expect(next.joins["join-1"]!.status).toBe("succeeded");
    expect(next.joins["join-1"]!.completedAt).toBe("2026-07-12T12:00:00.000Z");
  });

  it("resetJoinForRetry only resets concluded failures", () => {
    const execution = createWorkflowExecution({
      joins: { "join-1": buildJoin({ status: "running" }) },
    });

    const unchanged = resetJoinForRetry(
      execution,
      "join-1",
      "2026-07-12T12:00:00.000Z",
    );

    expect(unchanged.joins["join-1"]!.status).toBe("running");
  });
});

describe("single-transition-owner grep assertion (Phase 2 exit criterion)", () => {
  // Assignment-style writes to `status` / `mergeStatus` in the graph engine
  // must live in context-transitions.ts. The allowlist below names the writes
  // that are NOT context-status writes: execution-level status is hand-rolled
  // by design (decision D4), task-level status is out of this owner's scope,
  // and migrate-legacy repairs raw pre-parse records. Any new assignment
  // outside the allowlist fails this test — route it through
  // transitionContextStatus / transitionContextMergeStatus instead.
  const ALLOWED_STATUS_WRITES: Record<string, RegExp[]> = {
    "workflow-manager.ts": [
      // Execution-level lifecycle (D4: stays hand-rolled).
      /nextExecution\.status = status/,
      /execution\.status = "(running|completed)"/,
      // Task-level status.
      /taskState\.status = "interrupted"/,
    ],
    "iteration-orchestrator.ts": [
      // Task-level status.
      /taskState\.status = "(completed|pending)"/,
    ],
    "execution-tool-context.ts": [
      // Task-level status.
      /taskState\.status = "completed"/,
    ],
    "migrate-legacy-execution.ts": [
      // Pre-parse repair of raw Record<string, unknown> rows; runs before the
      // execution schema exists, so it cannot use the typed transition owner.
      /upgraded\.status = "paused"/,
    ],
  };

  it("no direct status/mergeStatus assignment exists outside context-transitions.ts", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const offenders: string[] = [];

    for (const relativePath of readdirSync(dir, { recursive: true })) {
      const fileName = String(relativePath);
      if (!fileName.endsWith(".ts")) continue;
      if (fileName.endsWith(".test.ts")) continue;
      // Test scaffolding builds states rather than transitioning them.
      if (fileName.endsWith("test-fixtures.ts")) continue;
      if (fileName.startsWith("testing/")) continue;
      if (fileName === "context-transitions.ts") continue;

      const content = readFileSync(path.join(dir, fileName), "utf8");
      const lines = content.split("\n");
      for (const [index, line] of lines.entries()) {
        if (!/\.(status|mergeStatus)\s*=[^=]/.test(line)) continue;
        const allowed = (ALLOWED_STATUS_WRITES[fileName] ?? []).some(
          (pattern) => pattern.test(line),
        );
        if (!allowed) {
          offenders.push(`${fileName}:${index + 1}: ${line.trim()}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  // Replacing an existing `contextStates[id]` entry wholesale is a status
  // transition in disguise — the rebuilt entry carries a fresh `status` that
  // the assignment scan above cannot see. This scan rejects both replacement
  // shapes: keyed entry assignment (`contextStates[id] = ...`) and map
  // rebuilds that override an entry (`{ ...x.contextStates, [id]: ... }`).
  // The allowlist names the writes that are NOT transitions of an existing
  // context; anything new must route through the owner's reset/transition API.
  const CONTEXT_STATE_REPLACEMENT_PATTERNS: RegExp[] = [
    /\.contextStates\[[^\]]+\]\s*=[^=]/g,
    /\.\.\.[\w$.]*contextStates\s*,\s*\[/g,
  ];

  const ALLOWED_CONTEXT_STATE_REPLACEMENTS: Record<string, RegExp[]> = {
    "runtime-edits.ts": [
      // add-context live edit: the entry is created for a context pushed into
      // the working definition by the same operation — construction of a new
      // context, not a transition of an existing one.
      /next\.contextStates\[op\.id\] = buildInitialContextState\(/,
      // materialize-loop-pass: the same construction case one pass instance at
      // a time — every id here was minted by this operation and pushed into the
      // working definition alongside it, so there is no existing context whose
      // lifecycle is being written over.
      /next\.contextStates\[instanceId\] = buildInitialContextState\(/,
    ],
    "lane-join.ts": [
      // appendPendingJoin spreads the existing entry and only sets `joinId`,
      // so status/mergeStatus are preserved — a field patch, not a transition.
      /\.\.\.execution\.contextStates,/,
    ],
  };

  it("no wholesale contextStates[id] replacement exists outside context-transitions.ts", () => {
    const dir = path.dirname(new URL(import.meta.url).pathname);
    const offenders: string[] = [];

    for (const relativePath of readdirSync(dir, { recursive: true })) {
      const fileName = String(relativePath);
      if (!fileName.endsWith(".ts")) continue;
      if (fileName.endsWith(".test.ts")) continue;
      // Test scaffolding builds states rather than transitioning them.
      if (fileName.endsWith("test-fixtures.ts")) continue;
      if (fileName.startsWith("testing/")) continue;
      if (fileName === "context-transitions.ts") continue;

      const content = readFileSync(path.join(dir, fileName), "utf8");
      for (const pattern of CONTEXT_STATE_REPLACEMENT_PATTERNS) {
        for (const match of content.matchAll(pattern)) {
          const lineNumber = content.slice(0, match.index).split("\n").length;
          const line = content.split("\n")[lineNumber - 1] ?? "";
          const allowed = (
            ALLOWED_CONTEXT_STATE_REPLACEMENTS[fileName] ?? []
          ).some((allowedPattern) => allowedPattern.test(line));
          if (!allowed) {
            offenders.push(`${fileName}:${lineNumber}: ${line.trim()}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
