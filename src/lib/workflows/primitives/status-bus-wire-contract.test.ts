/**
 * Wire contract for the shared session status bus and merge dispatch routing.
 *
 * Job-status events are the durable interface between the merge/commit
 * pipelines and every existing UI consumer, so their shapes must pass through
 * the shared `SessionStatusBus` unchanged:
 *
 *  - Every job-status lifecycle variant (running / completed / failed /
 *    conflicts) reaches the wire intact and maps to the documented StatusBus
 *    envelope status.
 *  - All optional job-status fields (mergeHash, commitHash, conflictCount,
 *    conflictFiles, errorMessage, phase) survive the bus verbatim.
 *  - Every documented `MergePhase` string round-trips through the payload's
 *    `phase` field.
 *  - `dispatchMergeJob`'s default broadcast routes job-status events through
 *    the shared session status bus end-to-end, so a refactor cannot silently
 *    drop the shared-bus routing without this test failing.
 *  - The imperative optimistic workflow (`@/lib/shared/optimistic`) keeps
 *    `dispatchMergeJob` as its terminal step with the real background-jobs
 *    dispatch as its default dep, preserving the smart-merge entrypoint and
 *    the AgentCall-routed prompt half (`executePromptStream` →
 *    `executePromptForMachine` → `dispatchTurnViaAgentCall` →
 *    `executeAgentCall`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fromPromise } from "xstate";

import {
  publishEvent,
  setPublicationBroadcastForTesting,
  subscribeLifecycle,
  _resetPublicationForTesting,
} from "@/lib/events/publication";
import type { StatusBusEnvelope } from "@/lib/events/status-bus";
import {
  dispatchMergeJob,
  _resetForTesting as _resetBackgroundJobsForTesting,
} from "@/lib/jobs/queue";
import { mergeMachine } from "@/lib/workflows/merge/machine";
import type {
  GetCurrentBranchInput,
  GetCurrentBranchOutput,
  MergeMainInput,
  MergeMainOutput,
  PrepareActorInput,
  PrepareActorOutput,
  PublishActorInput,
  PublishActorOutput,
  DiscardParkedRefInput,
  DiscardParkedRefOutput,
  ResolveConflictsInput,
  ResolveConflictsOutput,
  AnalyzeConflictsInput,
  AnalyzeConflictsOutput,
} from "@/lib/workflows/merge/actors";
import type {
  CheckUncommittedInput,
  CheckUncommittedOutput,
  CommitChangesInput,
  CommitChangesOutput,
  RunValidationInput,
  RunValidationOutput,
  FixValidationInput,
  FixValidationOutput,
} from "@/lib/workflows/validation-fix/actors";
import type { MergePhase } from "@/lib/workflows/merge/types";
import {
  defaultOptimisticDeps,
  executeOptimisticWorkflow,
} from "@/lib/shared/optimistic";
import type { SSEEvent } from "@/lib/api/sse-events";
import type { JobStatus, JobStatusEvent } from "@/lib/jobs/schemas";
import { sessionStateSchema, type SessionState } from "@/lib/sessions/schemas";
import { _createTestDb, _installTestDb } from "@/lib/state-store/state-db";

// `dispatchMergeJob`'s terminal-state path persists a job record and records a
// notification through the queue's real repos + notification service, all
// resolving `getStateDb()`. Installing a real in-memory SQLite DB (schema
// floored on open) lets that production wiring run end-to-end instead of
// replacing it with internal-module mocks; push dispatch is fire-and-forget
// and no-ops without push config, so nothing reaches the network. The DB is
// installed per test because the shared setup's beforeEach resets the
// state-db singleton, which closes any previously installed connection.

function captureWire() {
  const wire = vi.fn<(event: SSEEvent) => void>();
  setPublicationBroadcastForTesting(wire);
  return wire;
}

function captureEnvelopes() {
  const envelopes: StatusBusEnvelope[] = [];
  const unsubscribe = subscribeLifecycle((envelope) => {
    envelopes.push(envelope);
  });
  return { envelopes, unsubscribe };
}

function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("status-bus wire contract — job-status shapes, merge dispatch, optimistic terminal step", () => {
  beforeEach(() => {
    _resetPublicationForTesting();
    _resetBackgroundJobsForTesting();
    // Fresh in-memory DB per test — installed AFTER the shared setup's
    // beforeEach reset so the merge dispatch's real terminal-state persistence
    // runs against an isolated store.
    _installTestDb(_createTestDb({ inMemory: true }));
  });

  afterEach(() => {
    _resetPublicationForTesting();
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

        const outcome = publishEvent(event);
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

    publishEvent(event);
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
      "preparing",
      "publishing",
      "awaiting-land",
    ];

    for (const phase of phases) {
      publishEvent({
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
        getCurrentBranch: fromPromise<
          GetCurrentBranchOutput,
          GetCurrentBranchInput
        >(async () => ({ branch: "csm/session-1" })),
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
        prepare: fromPromise<PrepareActorOutput, PrepareActorInput>(
          async () => ({
            status: "prepared",
            preparedSha: "prepared-xyz",
            expectedTargetSha: "expected-xyz",
            parkedRef: "refs/cc-merges/test",
          }),
        ),
        publish: fromPromise<PublishActorOutput, PublishActorInput>(
          async () => ({ status: "completed", mergeHash: "merge-xyz" }),
        ),
        discardParkedRef: fromPromise<
          DiscardParkedRefOutput,
          DiscardParkedRefInput
        >(async () => undefined),
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

  it("executeOptimisticWorkflow dispatches a merge job after a successful prompt run (preserving the smart-merge entrypoint as the optimistic terminal step)", async () => {
    const dispatchSpy =
      vi.fn<(typeof defaultOptimisticDeps)["dispatchMergeJob"]>();
    const promptSpy =
      vi.fn<(typeof defaultOptimisticDeps)["executePromptStream"]>();
    const notificationSpy =
      vi.fn<(typeof defaultOptimisticDeps)["createNotification"]>();

    const session: SessionState = sessionStateSchema.parse({
      sessionName: "session-1",
      worktreePath: "/projects/acme/.worktrees/session-1",
      branchName: "csm/session-1",
      createdAt: "2026-04-28T00:00:00.000Z",
      lastActivityAt: "2026-04-28T00:00:00.000Z",
      conversations: [
        {
          id: "conv-1",
          transcriptPath: null,
          status: "new",
          promptCount: 0,
          createdAt: "2026-04-28T00:00:00.000Z",
          lastActivityAt: "2026-04-28T00:00:00.000Z",
        },
      ],
    });

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
        sleep: vi.fn().mockResolvedValue(undefined),
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
