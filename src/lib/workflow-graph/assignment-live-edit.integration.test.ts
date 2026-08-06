/**
 * The R11 lifecycle for an assignment edit, end to end over production parts:
 * the real live-edit pipeline mutating the execution the real cohort engine
 * then runs. The only fake is the single-specialist dispatch.
 */

import { describe, expect, it } from "vitest";
import type { SessionState } from "@/lib/sessions/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import {
  applyLiveEditsToActiveExecution,
  type LiveEditApplyServiceDeps,
} from "./live-edit-apply";
import { assignmentFingerprint } from "./lane-identity";
import type { LiveEditDeps, ResolvedContextConfig } from "./runtime-edits";
import type { GraphWorkflowExecution } from "./schemas";
import { makeProfileSnapshot, makeValidatorAssignment } from "./test-fixtures";
import { prepareLiveEditAssignmentSnapshots } from "./live-edit-preparation";
import {
  createCohortExecution,
  createHarness,
  metadata,
  passResult,
  specialistRecord,
  withOpenRound,
  type Harness,
} from "./testing/cohort-engine-harness";

const RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: {
    id: "implementer",
    profile: { tier: "builtin", id: "general-implementer" },
    profileSnapshot: makeProfileSnapshot(),
    agent: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  },
  contextValidator: { enabled: false, assignments: [] },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: { allowAgentTaskAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: false, source: "global" },
    secondAgent: {
      value: { backend: "claude", model: "sonnet", reasoningEffort: "medium" },
      source: "global",
    },
    negotiationRounds: { value: 3, source: "global" },
    autonomousResolutionThreshold: { value: "minor", source: "global" },
  },
  agentValidation: {
    implementer: { value: { mode: "all", except: [] }, source: "global" },
    contextValidator: {
      value: { mode: "only", commands: [] },
      source: "global",
    },
  },
};

const LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
  snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
  validationCommandPreflight: () => ({
    commandCosts: {},
    concurrencyLimit: 8,
  }),
  now: () => "2026-08-04T12:00:00.000Z",
};

/**
 * Mirrors the real composer's one property this file depends on: the delivered
 * block covers the profile AND the assignment focus, so refocusing a seat moves
 * `resolvedInstructionHash`. A fixture that ignored focus would hide the very
 * rotation these tests are about.
 */
const composedHashes = new Map<string, string>();
function composedHash(assignment: {
  profile: { tier: string; id: string };
  focus?: string;
}): string {
  const key = `${assignment.profile.tier}:${assignment.profile.id}:${assignment.focus ?? ""}`;
  const existing = composedHashes.get(key);
  if (existing !== undefined) return existing;
  const composed = `sha256:${String(composedHashes.size + 1).padStart(64, "0")}`;
  composedHashes.set(key, composed);
  return composed;
}

/** The live-edit service over the harness repository, so both share state. */
function editDeps(harness: Harness): LiveEditApplyServiceDeps {
  return {
    getActiveExecution: () => harness.repository.getActive(),
    mutateActive: (projectPath, sessionName, fn) =>
      harness.repository.mutateActive(projectPath, sessionName, fn),
    buildLiveEditDeps: () => Promise.resolve(LIVE_EDIT_DEPS),
    prepareAssignmentSnapshots: (_projectPath, operations) =>
      prepareLiveEditAssignmentSnapshots({
        operations,
        composeSnapshot: async (assignment) =>
          makeProfileSnapshot({
            ...assignment.profile,
            resolvedInstructionHash: composedHash(assignment),
          }),
      }),
    publishLiveEditApplied: () => ({ events: [], pushes: [] }),
    publishCharterUpdated: () => ({ events: [], pushes: [] }),
    getSession: () =>
      Promise.resolve({ worktreePath: "/wt" } as unknown as SessionState),
    writeCharterDocument: () => Promise.resolve(),
  };
}

function applyEdit(
  harness: Harness,
  execution: GraphWorkflowExecution,
  operations: WorkflowLiveEditOperation[],
) {
  return applyLiveEditsToActiveExecution(
    {
      projectPath: "/repo",
      sessionName: "session-1",
      request: {
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        source: "ui",
        operations,
      },
    },
    editDeps(harness),
  );
}

function cohortEdit(ids: readonly string[]): WorkflowLiveEditOperation {
  return {
    type: "update-context",
    contextId: "context-plan",
    contextValidator: {
      enabled: true,
      assignments: ids.map((id) => makeValidatorAssignment({ id })),
    },
  };
}

describe("assignment edits on a live execution (R11)", () => {
  it("refuses a cohort edit on a started context until the execution is paused", async () => {
    const harness = createHarness({
      execution: withOpenRound(
        createCohortExecution({ assignmentIds: ["alpha", "beta"] }),
        {
          specialists: {
            alpha: specialistRecord({ state: "verdict_pass", attempts: 1 }),
            beta: specialistRecord({ state: "pending" }),
          },
        },
      ),
      runContextValidator: async () => {
        throw new Error("no validator should run in this test");
      },
    });

    const outcome = await applyEdit(harness, harness.repository.read(), [
      cohortEdit(["alpha", "gamma"]),
    ]);

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "rejected") return;
    expect(outcome.failure.code).toBe("requires_pause");
    // Nothing changed: the cohort the round froze is still the cohort on record.
    const context = harness.repository
      .read()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      );
    expect(
      context?.contextValidator.assignments.map((entry) => entry.id),
    ).toEqual(["alpha", "beta"]);
  });

  it("discards the paused round's verdicts and runs the edited roster as a fresh round on resume", async () => {
    const harness = createHarness({
      execution: withOpenRound(
        createCohortExecution({ assignmentIds: ["alpha", "beta"] }),
        {
          seq: 4,
          specialists: {
            alpha: specialistRecord({
              state: "verdict_pass",
              attempts: 1,
              summary: "Looks good to me",
            }),
            beta: specialistRecord({ state: "pending" }),
          },
        },
      ),
      runContextValidator: async (input) => ({
        result: passResult(input.validator.id),
        metadata: metadata(),
      }),
    });

    await harness.pause();

    const pausedRound = harness.contextState()?.validationRound;
    expect(pausedRound?.phase).toBe("concluded");
    // Concluded with NO outcome: nothing the round collected is recorded, and
    // its seq survives so the next round cannot be confused with it.
    expect(pausedRound?.outcome).toBeNull();
    expect(pausedRound?.seq).toBe(4);

    const edited = await applyEdit(harness, harness.repository.read(), [
      cohortEdit(["alpha", "gamma"]),
    ]);
    expect(edited.ok).toBe(true);

    await harness.resumeHalt();
    await harness.run();

    const round = harness.contextState()?.validationRound;
    expect(round?.seq).toBe(5);
    expect(round?.roster.map((seat) => seat.assignmentId)).toEqual([
      "alpha",
      "gamma",
    ]);
    // alpha's earlier pass is gone — the new round re-reviews from scratch.
    expect(round?.specialists["alpha"]?.summary).not.toBe("Looks good to me");
    expect(
      harness.runContextValidator.mock.calls.map(
        (call) => (call[0] as { validator: { id: string } }).validator.id,
      ),
    ).toEqual(["alpha", "gamma"]);
  });

  it("moves the edited assignment's fingerprint, which is what rotates its lane", async () => {
    const execution = createCohortExecution({ assignmentIds: ["alpha"] });
    execution.status = "paused";
    const harness = createHarness({
      execution,
      runContextValidator: async () => {
        throw new Error("no validator should run in this test");
      },
    });
    const before = harness.repository
      .read()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      )!.contextValidator.assignments[0]!;

    const refocus = await applyEdit(harness, harness.repository.read(), [
      {
        type: "update-context",
        contextId: "context-plan",
        contextValidator: {
          enabled: true,
          assignments: [
            makeValidatorAssignment({
              id: "alpha",
              focus: "Concurrency and data races",
            }),
          ],
        },
      },
    ]);
    expect(refocus.ok).toBe(true);

    const after = harness.repository
      .read()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      )!.contextValidator.assignments[0]!;

    // Same seat id, different delivered bytes: `assignment_changed` rotation.
    expect(after.id).toBe("alpha");
    expect(assignmentFingerprint(after)).not.toBe(
      assignmentFingerprint(before),
    );
  });

  it("refuses to re-enable a migrated empty cohort unless the same edit adds an assignment", async () => {
    const execution = createCohortExecution({ assignmentIds: ["alpha"] });
    execution.status = "paused";
    const context = execution.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-plan",
    )!;
    // The honest migration of a legacy bare `enabled: false`.
    context.contextValidator = { enabled: false, assignments: [] };
    const harness = createHarness({
      execution,
      runContextValidator: async () => {
        throw new Error("no validator should run in this test");
      },
    });

    const bareEnable = await applyEdit(harness, harness.repository.read(), [
      {
        type: "update-context",
        contextId: "context-plan",
        contextValidator: { enabled: true, assignments: [] },
      },
    ]);
    expect(bareEnable.ok).toBe(false);
    if (bareEnable.ok || bareEnable.kind !== "rejected") return;
    expect(bareEnable.failure.issues?.[0]?.message).toMatch(/vacuously/i);

    const enableWithMember = await applyEdit(
      harness,
      harness.repository.read(),
      [cohortEdit(["alpha"])],
    );
    expect(enableWithMember.ok).toBe(true);
  });
});
