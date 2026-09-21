import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
/**
 * The R11 lifecycle for an assignment edit, end to end over production parts:
 * the real live-edit pipeline mutating the execution the real cohort engine
 * then runs. The only fake is the single-specialist dispatch.
 */

import { describe, expect, it } from "vitest";
import { PROFILE_BLOCK_BEGIN } from "@/lib/agent-profiles/composer";
import type { SessionState } from "@/lib/sessions/schemas";
import type { WorkflowLiveEditOperation } from "@/lib/workflows/edit-schemas";
import {
  applyLiveEditsToActiveExecution,
  buildDefaultAssignmentSnapshotPreparation,
  type LiveEditApplyServiceDeps,
} from "./live-edit-apply";
import { assignmentFingerprint } from "./lane-identity";
import {
  buildValidatorRoleContract,
  composeWorkflowRoleInstructions,
} from "./role-instructions";
import type { ValidatorAssignment } from "./config-schemas";
import type {
  LiveEditDeps,
  LiveEditSource,
  ResolvedContextConfig,
} from "./runtime-edits";
import {
  expandPlanRepairOperations,
  validatePlanRepairOperations,
} from "./plan-repair/schemas";
import type { GraphWorkflowExecution } from "./schemas";
import {
  makeProfileSnapshot,
  makeSeededValidatorAssignment,
  makeValidatorAssignment,
} from "./test-fixtures";
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
    agent: {
      backend: "claude",
      modelSelection: { modelId: "opus", parameters: { effort: "medium" } },
    },
  },
  contextValidator: { enabled: false, assignments: [] },
  scriptValidator: { commands: [] },
  humanApprovalGate: { enabled: false },
  askUserQuestions: { enabled: false },
  mutability: {
    allowAgentTaskAdd: false,
    allowAgentContextAdd: false,
  },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20 },
  planRepair: { enabled: true, maxAttemptsPerContext: 2 },
  collaboration: {
    enabled: { value: false, source: "global" },
    secondAgent: {
      value: {
        backend: "claude",
        modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
      },
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
  memory: {
    implementer: {
      read: { value: "ambient", source: "global" },
      contribute: { value: "on", source: "global" },
    },
    validator: {
      read: { value: "off", source: "global" },
      contribute: { value: "off", source: "global" },
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
 * instruction changes these tests exercise.
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
    executionContract: createTestGraphExecutionContract(),
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
  source: LiveEditSource = "ui",
) {
  return applyLiveEditsToActiveExecution(
    {
      projectPath: "/repo",
      sessionName: "session-1",
      request: {
        executionId: execution.id,
        baseLiveRevision: execution.liveRevision,
        source,
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

/**
 * R10.1 — the narrowing a repair emits, from the allowlist that admits it to
 * the execution it lands on.
 *
 * The allowlist expands one narrowing op into a cohort write, so what matters
 * is not that the expansion parses but that the real apply core accepts it on a
 * halted execution and changes exactly the one seat it names. Both halves run
 * here; only the single-specialist dispatch is faked, and it never runs.
 */
describe("a plan-repair narrowing reaches the cohort (R10.1)", () => {
  it("demotes and refocuses the named seat, leaving its sibling untouched", async () => {
    const execution = createCohortExecution({
      assignments: [
        makeSeededValidatorAssignment({
          id: "alpha",
          authority: "blocking",
          focus: "Judge this context against the threat model.",
        }),
        makeSeededValidatorAssignment({ id: "beta", authority: "advisory" }),
      ],
    });
    execution.status = "halted";
    execution.haltReason = {
      type: "circuit_breaker",
      contextId: "context-plan",
      condition: "retry_exhaustion",
      failureCount: 3,
      summary: null,
    };
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
      )!.contextValidator.assignments;

    const validated = validatePlanRepairOperations(
      [
        {
          type: "update-validator-assignment",
          contextId: "context-plan",
          assignmentId: "alpha",
          authority: "advisory",
          instructions: "Report threat-model concerns as advisories.",
        },
      ],
      harness.repository.read().workingDefinition.executionContexts,
    );
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    // The supervisor's sequence: the cohort write is built from the state the
    // apply is about to be revision-guarded against.
    const expanded = expandPlanRepairOperations(
      validated.operations,
      harness.repository.read().workingDefinition.executionContexts,
    );
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;

    const applied = await applyEdit(
      harness,
      harness.repository.read(),
      expanded.operations,
      "plan-repair",
    );
    expect(applied.ok).toBe(true);

    const after = harness.repository
      .read()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-plan",
      )!.contextValidator;

    expect(after.enabled).toBe(true);
    expect(after.assignments.map((entry) => entry.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(after.assignments[0]).toMatchObject({
      authority: "advisory",
      focus: "Report threat-model concerns as advisories.",
    });
    // Before its first turn, the seat can receive a different review mandate.
    expect(assignmentFingerprint(after.assignments[0]!)).not.toBe(
      assignmentFingerprint(before[0]!),
    );
    // The sibling passed through the expansion with its configuration intact.
    // Its snapshot is re-pinned, as it is for every seat in any cohort write —
    // what a narrowing must not do is change what the seat IS.
    const authored = ({ profileSnapshot, ...rest }: (typeof before)[number]) =>
      rest;
    expect(authored(after.assignments[1]!)).toEqual(authored(before[1]!));
  });
});

/**
 * R4.1 — where a live-edited assignment's authored instructions land.
 *
 * The production preparation closure is the subject here, not a stand-in for
 * it. A live edit is the one path that composes a seat's profile block AFTER
 * execution start, so a placement rule applied only at seed time would deliver
 * a live-added or newly promoted blocking seat's instructions twice: once as
 * the mandate the role contract renders above the fence, and again inside the
 * block. Builtin profiles resolve out of code with no storage access, so the
 * real closure runs here unmodified — the only thing this file fakes elsewhere.
 */
describe("live-edited assignment instruction placement (R4.1)", () => {
  const MANDATE =
    "Judge this context against the rollback plan the migration declares.";

  function preparationFor(assignments: ValidatorAssignment[]) {
    return buildDefaultAssignmentSnapshotPreparation("/repo", [
      {
        type: "update-context",
        contextId: "context-plan",
        contextValidator: { enabled: true, assignments },
      },
    ]);
  }

  async function snapshotsFor(assignments: ValidatorAssignment[]) {
    const preparation = await preparationFor(assignments);
    if (!preparation.ok) {
      throw new Error(
        `preparation rejected: ${JSON.stringify(preparation.issues)}`,
      );
    }
    return assignments.map((assignment) =>
      preparation.prepared.snapshotFor(assignment),
    );
  }

  function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("withholds a blocking seat's mandate from the block it composes", async () => {
    const [snapshot] = await snapshotsFor([
      makeValidatorAssignment({
        id: "alpha",
        authority: "blocking",
        focus: MANDATE,
      }),
    ]);

    expect(snapshot?.renderedInstructionBlock).not.toContain(MANDATE);
  });

  it("keeps an advisory seat's focus inside the block it composes", async () => {
    const [snapshot] = await snapshotsFor([
      makeValidatorAssignment({
        id: "alpha",
        authority: "advisory",
        focus: MANDATE,
      }),
    ]);

    expect(snapshot?.renderedInstructionBlock).toContain(MANDATE);
  });

  it("delivers a live-edited mandate exactly once, above the fence", async () => {
    const blocking = makeValidatorAssignment({
      id: "alpha",
      authority: "blocking",
      focus: MANDATE,
    });
    const [snapshot] = await snapshotsFor([blocking]);

    // The two production functions the validator runner composes for a lane,
    // over the bytes the live edit actually committed.
    const payload = composeWorkflowRoleInstructions({
      roleContract: buildValidatorRoleContract({
        authority: "blocking",
        mandate: blocking.focus ?? "",
      }),
      profileBlock: snapshot?.renderedInstructionBlock ?? "",
    });

    expect(occurrences(payload, MANDATE)).toBe(1);
    expect(payload.indexOf(MANDATE)).toBeLessThan(
      payload.indexOf(PROFILE_BLOCK_BEGIN),
    );
  });

  it("composes distinct bytes for two seats that share a profile and a focus but not an authority", async () => {
    // The preparation cache is keyed on what the composer was given. Authority
    // now decides that, so a key blind to it would hand the second seat the
    // first one's block — placement by whichever seat the op happened to list
    // first.
    const [blocking, advisory] = await snapshotsFor([
      makeValidatorAssignment({
        id: "alpha",
        authority: "blocking",
        focus: MANDATE,
      }),
      makeValidatorAssignment({
        id: "beta",
        authority: "advisory",
        focus: MANDATE,
      }),
    ]);

    expect(blocking?.renderedInstructionBlock).not.toContain(MANDATE);
    expect(advisory?.renderedInstructionBlock).toContain(MANDATE);
  });
});
