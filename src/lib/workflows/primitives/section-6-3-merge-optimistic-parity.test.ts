/**
 * Section 6.3 — smart-merge + optimistic workflow parity verification.
 *
 * Task 6.3 of the composable-workflow-primitives spec requires that smart-merge
 * and optimistic workflows be adapted to shared agent-powered substeps —
 * routing merge-specific agent steps through shared execution, status, and
 * artifact flows — **without changing the request/response shapes, event
 * names, artifact paths, or durable state visible to existing callers**.
 *
 * The primary migrations are in place:
 *  - `background-jobs.ts` defaults to `publishSessionStatus` for every
 *    job-status broadcast (running / completed / failed / conflicts).
 *  - `merge-detection.ts` defaults to `publishSessionStatus` for every
 *    `session-finished` broadcast.
 *  - `validation-fix.ts` builds `task_run` `AgentCallRequest`s and dispatches
 *    them through the shared `executeAgentCall` facade (verified by the
 *    "validation-fix.fixValidationErrors builds a write_capable task_run
 *    request through deps.executeAgentCall" test below).
 *  - `conflict-resolution.ts` builds `task_run` `AgentCallRequest`s for
 *    both the resolve (write_capable) and analyze (read_only) paths and
 *    dispatches them through the shared `executeAgentCall` facade (verified
 *    by the two "conflict-resolution.* builds a … task_run request through
 *    deps.executeAgentCall" tests below).
 *  - `optimistic.ts` enters the `AgentCall` primitive through the conversation
 *    actor (`executePromptStream` → `executePromptForMachine` →
 *    `dispatchTurnViaAgentCall` → `executeAgentCall`) and then dispatches the
 *    terminal merge job through `dispatchMergeJob`, so both halves of the
 *    optimistic flow flow through the shared bus.
 *
 * These tests act as parity guards: every job-status lifecycle variant the
 * existing UI consumes must still pass through the shared bus unchanged, all
 * optional job-status fields (mergeHash, commitHash, conflictCount,
 * conflictFiles, errorMessage, phase) must survive intact, every documented
 * `MergePhase` string must round-trip, and `session-finished` events must
 * remain scoped under `merge_job`. The dispatchMergeJob integration check
 * locks the default broadcast wiring so that a future refactor cannot
 * silently drop the shared-bus routing without this test failing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromPromise } from "xstate";

import {
  publishSessionStatus,
  setDefaultSessionStatusBusBroadcastForTesting,
  subscribeSessionStatus,
  _resetDefaultSessionStatusBusForTesting,
} from "./default-session-status-bus";
import type { StatusBusEnvelope } from "./status-bus";
import {
  dispatchMergeJob,
  _resetForTesting as _resetBackgroundJobsForTesting,
} from "@/lib/background-jobs";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  MergeMainInput,
  MergeMainOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
  SquashMergeInput,
  SquashMergeOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
} from "@/lib/workflows/merge/actors";
import type { MergePhase } from "@/lib/workflows/merge/types";
import {
  defaultOptimisticDeps,
  executeOptimisticWorkflow,
} from "@/lib/optimistic";
import type {
  JobStatus,
  JobStatusEvent,
  SessionFinishedEvent,
  SSEEvent,
  SessionState,
} from "@/types";

// notification-db is a real SQLite dependency — the existing
// background-jobs.test.ts mocks it the same way, and CLAUDE.md permits
// vi.mock for infrastructure modules with module-level side effects.
vi.mock("@/lib/notification-db");

function captureWire() {
  const wire = vi.fn<(event: SSEEvent) => void>();
  setDefaultSessionStatusBusBroadcastForTesting(wire);
  return wire;
}

function captureEnvelopes() {
  const envelopes: StatusBusEnvelope[] = [];
  const unsubscribe = subscribeSessionStatus((envelope) => {
    envelopes.push(envelope);
  });
  return { envelopes, unsubscribe };
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("section 6.3 — merge + optimistic workflow parity (Task 6.3)", () => {
  beforeEach(() => {
    _resetDefaultSessionStatusBusForTesting();
    _resetBackgroundJobsForTesting();
  });

  afterEach(() => {
    _resetDefaultSessionStatusBusForTesting();
    _resetBackgroundJobsForTesting();
  });

  describe("job-status preserves every lifecycle variant on the wire", () => {
    const cases: Array<{
      status: JobStatus;
      expectedScopeStatus: "running" | "paused" | "completed" | "failed";
    }> = [
      { status: "running", expectedScopeStatus: "running" },
      { status: "completed", expectedScopeStatus: "completed" },
      { status: "failed", expectedScopeStatus: "failed" },
      { status: "conflicts", expectedScopeStatus: "paused" },
    ];

    for (const { status, expectedScopeStatus } of cases) {
      it(`preserves job-status payload for status=${status} and maps to envelope status=${expectedScopeStatus}`, () => {
        const wire = captureWire();
        const { envelopes, unsubscribe } = captureEnvelopes();

        const event: JobStatusEvent = {
          type: "job-status",
          jobType: "merge",
          status,
          projectName: "acme",
          sessionName: "session-1",
          jobId: "job-1",
          branchName: "csm/session-1",
        };

        const outcome = publishSessionStatus(event);
        unsubscribe();

        expect(outcome.delivered).toBe(true);
        expect(wire.mock.calls[0]?.[0]).toEqual(event);
        expect(envelopes).toHaveLength(1);
        expect(envelopes[0]?.scope).toBe("merge_job");
        expect(envelopes[0]?.scopeId).toBe("job-1");
        expect(envelopes[0]?.status).toBe(expectedScopeStatus);
      });
    }
  });

  it("preserves every optional job-status field on the wire (mergeHash, commitHash, conflictCount, conflictFiles, errorMessage, phase)", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: JobStatusEvent = {
      type: "job-status",
      jobType: "merge",
      status: "completed",
      projectName: "acme",
      sessionName: "session-1",
      jobId: "job-1",
      branchName: "csm/session-1",
      mergeHash: "merge-abc",
      commitHash: "commit-def",
      conflictCount: 2,
      conflictFiles: ["src/a.ts", "src/b.ts"],
      errorMessage: "validation failed before fix",
      phase: "squash-merging",
    };

    publishSessionStatus(event);
    unsubscribe();

    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes[0]?.payload).toEqual(event);
  });

  it("preserves every MergePhase string value through the wire payload's phase field", () => {
    const wire = captureWire();
    const { unsubscribe } = captureEnvelopes();

    const phases: MergePhase[] = [
      "committing-uncommitted",
      "merging-main",
      "analyzing-conflicts",
      "resolving-conflicts",
      "validating",
      "fixing-validation",
      "re-validating",
      "squash-merging",
    ];

    for (const phase of phases) {
      publishSessionStatus({
        type: "job-status",
        jobType: "merge",
        status: "running",
        projectName: "acme",
        sessionName: "session-1",
        jobId: "job-1",
        branchName: "csm/session-1",
        phase,
      });
    }

    unsubscribe();

    const phasesOnWire = wire.mock.calls
      .map((c) => c[0])
      .filter((e): e is JobStatusEvent => e.type === "job-status")
      .map((e) => e.phase);

    expect(phasesOnWire).toEqual(phases);
  });

  it("preserves session-finished payload through the shared bus with the merge_job scope envelope (ancestor detection)", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: SessionFinishedEvent = {
      type: "session-finished",
      projectName: "acme",
      sessionName: "session-1",
      branchName: "csm/session-1",
      detectionMethod: "ancestor",
    };

    const outcome = publishSessionStatus(event);
    unsubscribe();

    expect(outcome.delivered).toBe(true);
    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes).toHaveLength(1);
    expect(envelopes[0]?.scope).toBe("merge_job");
    expect(envelopes[0]?.scopeId).toBe("csm/session-1");
    expect(envelopes[0]?.status).toBe("completed");
  });

  it("preserves session-finished payload through the shared bus with the merge_job scope envelope (commit-message detection)", () => {
    const wire = captureWire();
    const { envelopes, unsubscribe } = captureEnvelopes();

    const event: SessionFinishedEvent = {
      type: "session-finished",
      projectName: "acme",
      sessionName: "session-1",
      branchName: "csm/session-1",
      detectionMethod: "commit-message",
    };

    publishSessionStatus(event);
    unsubscribe();

    expect(wire.mock.calls[0]?.[0]).toEqual(event);
    expect(envelopes[0]?.scope).toBe("merge_job");
    expect(envelopes[0]?.status).toBe("completed");
  });

  it("dispatchMergeJob default broadcast routes job-status events through the shared session status bus end-to-end", async () => {
    const wire = captureWire();

    // Build a real merge machine with mock actors so dispatchMergeJob's
    // subscribe path drives the broadcast pathway under test.
    const machine = mergeMachine.provide({
      actors: {
        checkUncommitted: fromPromise<
          CheckUncommittedOutput,
          CheckUncommittedInput
        >(async () => ({ hasChanges: false })),
        commitChanges: fromPromise<CommitChangesOutput, CommitChangesInput>(
          async () => ({ hash: "commit-abc" }),
        ),
        mergeMain: fromPromise<MergeMainOutput, MergeMainInput>(async () => ({
          status: "clean",
          conflictFiles: [],
        })),
        resolveConflicts: fromPromise<
          ResolveConflictsOutput,
          ResolveConflictsInput
        >(async () => ({ status: "resolved", conflicts: [] })),
        analyzeConflicts: fromPromise<
          AnalyzeConflictsOutput,
          AnalyzeConflictsInput
        >(async () => ({ status: "analyzed", conflicts: [] })),
        runValidation: fromPromise<RunValidationOutput, RunValidationInput>(
          async () => undefined,
        ),
        fixValidation: fromPromise<FixValidationOutput, FixValidationInput>(
          async () => ({ status: "fixed" }),
        ),
        squashMerge: fromPromise<SquashMergeOutput, SquashMergeInput>(
          async () => ({ mergeHash: "merge-xyz" }),
        ),
      },
    });

    const result = dispatchMergeJob({
      projectPath: "/projects/acme",
      projectName: "acme",
      sessionName: "session-1",
      worktreePath: "/projects/acme/.worktrees/session-1",
      branchName: "csm/session-1",
      message: "Merge session-1",
      autoResolve: false,
      acquireSessionLock: () => () => {},
      machine,
    });

    expect(result.ok).toBe(true);

    // Wait for the merge actor to complete its async chain so terminal
    // job-status (status=completed, mergeHash=...) reaches the wire.
    await settle();

    const jobStatuses = wire.mock.calls
      .map((c) => c[0])
      .filter((e): e is JobStatusEvent => e.type === "job-status");

    expect(jobStatuses.length).toBeGreaterThanOrEqual(2);
    expect(jobStatuses[0]).toMatchObject({
      type: "job-status",
      jobType: "merge",
      status: "running",
      projectName: "acme",
      sessionName: "session-1",
      branchName: "csm/session-1",
    });

    const terminal = jobStatuses[jobStatuses.length - 1]!;
    expect(terminal.status).toBe("completed");
    expect(terminal.mergeHash).toBe("merge-xyz");
    expect(terminal.projectName).toBe("acme");
    expect(terminal.sessionName).toBe("session-1");
    expect(terminal.branchName).toBe("csm/session-1");
  });

  it("executeOptimisticWorkflow's default deps wire dispatchMergeJob to the real background-jobs dispatch (so the broadcast chain reaches the shared bus)", () => {
    expect(defaultOptimisticDeps.dispatchMergeJob).toBe(dispatchMergeJob);
  });

  describe("smart-merge + planner + optimistic route through executeAgentCall (Task 6.3)", () => {
    const baseConfig = {
      baseDir: "/home/user/projects",
      ignorePatterns: [],
      claudeTimeoutMs: 60_000,
      defaultModel: "opus",
    };

    function createTestRunner(result: {
      text?: string | null;
      error?: string | null;
    }) {
      return {
        backend: "claude" as const,
        run: vi.fn().mockResolvedValue({
          backendRef: null,
          text: result.text ?? null,
          structuredOutput: undefined,
          usage: null,
          error: result.error ?? null,
          timedOut: false,
        }),
      };
    }

    it("conflict-resolution.resolveConflicts builds a write_capable task_run request through deps.executeAgentCall", async () => {
      const { createConflictResolver } =
        await import("@/lib/conflict-resolution");
      const { executeAgentCall: defaultExecuteAgentCall } =
        await import("./agent-call-facade");
      const conflictEntries = [
        {
          file: "src/index.ts",
          description: "Conflict",
          resolution: "Resolved",
          rationale: "Reason",
        },
      ];
      const text = `\`\`\`json\n${JSON.stringify({ conflicts: conflictEntries })}\n\`\`\``;
      const runner = createTestRunner({ text });
      const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

      const resolver = createConflictResolver({
        getTaskRunner: () => runner,
        readConfig: vi.fn().mockResolvedValue(baseConfig),
        executeAgentCall: executeAgentCallSpy,
      });

      const result = await resolver.resolveConflicts({
        worktreePath: "/tmp/worktree",
      });

      expect(result.status).toBe("resolved");
      expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
      const [request] = executeAgentCallSpy.mock.calls[0]!;
      expect(request).toMatchObject({
        kind: "task_run",
        backend: "claude",
        writeCapability: "write_capable",
      });
    });

    it("conflict-resolution.analyzeConflicts builds a read_only task_run request through deps.executeAgentCall", async () => {
      const { createConflictResolver } =
        await import("@/lib/conflict-resolution");
      const { executeAgentCall: defaultExecuteAgentCall } =
        await import("./agent-call-facade");
      const conflictEntries = [
        {
          file: "src/index.ts",
          description: "Conflict",
          resolution: "Proposed",
          rationale: "Reason",
        },
      ];
      const text = `\`\`\`json\n${JSON.stringify({ conflicts: conflictEntries })}\n\`\`\``;
      const runner = createTestRunner({ text });
      const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

      const resolver = createConflictResolver({
        getTaskRunner: () => runner,
        readConfig: vi.fn().mockResolvedValue(baseConfig),
        executeAgentCall: executeAgentCallSpy,
      });

      const result = await resolver.analyzeConflicts({
        worktreePath: "/tmp/worktree",
      });

      expect(result.status).toBe("analyzed");
      expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
      const [request] = executeAgentCallSpy.mock.calls[0]!;
      expect(request).toMatchObject({
        kind: "task_run",
        backend: "claude",
        writeCapability: "read_only",
      });
    });

    it("validation-fix.fixValidationErrors builds a write_capable task_run request through deps.executeAgentCall", async () => {
      const { createValidationFixer } = await import("@/lib/validation-fix");
      const { executeAgentCall: defaultExecuteAgentCall } =
        await import("./agent-call-facade");
      const runner = createTestRunner({ text: "fixed" });
      const executeAgentCallSpy = vi.fn(defaultExecuteAgentCall);

      const fixer = createValidationFixer({
        getTaskRunner: () => runner,
        readConfig: vi.fn().mockResolvedValue(baseConfig),
        executeAgentCall: executeAgentCallSpy,
      });

      const result = await fixer.fixValidationErrors({
        worktreePath: "/tmp/worktree",
        validationOutput: "lint: 1 error",
      });

      expect(result.status).toBe("fixed");
      expect(executeAgentCallSpy).toHaveBeenCalledTimes(1);
      const [request] = executeAgentCallSpy.mock.calls[0]!;
      expect(request).toMatchObject({
        kind: "task_run",
        backend: "claude",
        writeCapability: "write_capable",
      });
    });
  });

  it("executeOptimisticWorkflow dispatches a merge job after a successful prompt run (preserving the smart-merge entrypoint as the optimistic terminal step)", async () => {
    const dispatchSpy =
      vi.fn<(typeof defaultOptimisticDeps)["dispatchMergeJob"]>();
    const promptSpy =
      vi.fn<(typeof defaultOptimisticDeps)["executePromptStream"]>();
    const notificationSpy =
      vi.fn<(typeof defaultOptimisticDeps)["createNotification"]>();

    const session: SessionState = {
      sessionName: "session-1",
      worktreePath: "/projects/acme/.worktrees/session-1",
      branchName: "csm/session-1",
      finished: false,
      status: "active",
      conversations: [
        {
          id: "conv-1",
          title: null,
          phase: "idle",
          objective: null,
          createdAt: "2026-04-28T00:00:00.000Z",
        },
      ],
      objective: "Old objective",
      createdAt: "2026-04-28T00:00:00.000Z",
    } as unknown as SessionState;

    await executeOptimisticWorkflow(
      {
        projectPath: "/projects/acme",
        projectName: "acme",
        session,
        instructions: "do the thing",
      },
      {
        executePromptStream: promptSpy,
        dispatchMergeJob: dispatchSpy,
        createNotification: notificationSpy,
      },
    );

    expect(promptSpy).toHaveBeenCalledTimes(1);
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(notificationSpy).not.toHaveBeenCalled();

    const dispatchArgs = dispatchSpy.mock.calls[0]?.[0];
    expect(dispatchArgs).toMatchObject({
      projectPath: "/projects/acme",
      projectName: "acme",
      sessionName: "session-1",
      worktreePath: "/projects/acme/.worktrees/session-1",
      branchName: "csm/session-1",
      autoResolve: true,
    });
  });
});
