import { applyFixtureMutation } from "@/lib/workflow-graph/testing/execution-mutation-fixture";
import { createNonParticipatingGraphExecutionContract } from "@/lib/workflow-graph/execution-contract-port";
import { describe, expect, it } from "vitest";
import { AgentProfileNotResolvableError } from "@/lib/agent-profiles/library-service";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  makeProfileSnapshot,
  makeValidatorAssignment,
} from "./test-fixtures";
import {
  applyLiveEditsToActiveExecution,
  type LiveEditApplyRequest,
  type LiveEditApplyServiceDeps,
} from "./live-edit-apply";
import { prepareLiveEditAssignmentSnapshots } from "./live-edit-preparation";
import type { LiveEditDeps, ResolvedContextConfig } from "./runtime-edits";
import type { GraphWorkflowExecution } from "./schemas";
import type {
  PublishCharterUpdatedInput,
  PublishLiveEditAppliedInput,
} from "./execution-events";

import type { SessionState } from "@/lib/sessions/schemas";

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
  mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: false },
  circuitBreaker: { consecutiveFailureThreshold: 3 },
  iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
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

/** A hash shaped like the real thing — the execution schema pins the format. */
function hash(seed: string): string {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}
const SECURITY_V1 = hash("a");
const SECURITY_V2 = hash("b");

const LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
  validationCommandPreflight: () => ({
    commandCosts: {},
    concurrencyLimit: 8,
  }),
  snapshotFor: (assignment) => makeProfileSnapshot({ ...assignment.profile }),
  now: () => "2026-07-29T00:00:00.000Z",
};

interface Harness {
  deps: LiveEditApplyServiceDeps;
  current(): GraphWorkflowExecution;
  liveEditApplied: PublishLiveEditAppliedInput[];
  charterUpdated: PublishCharterUpdatedInput[];
  charterWrites: { worktreePath: string; markdown: string }[];
  mutations: number;
  /** Profile id -> the instruction hash the library would compose right now. */
  library: Map<string, string>;
  prepareCalls: number;
  /** Runs inside `mutateActive`, before the reducer — the race window. */
  beforeMutation: (() => void) | null;
  /** Simulate a concurrent edit committing against the stored execution. */
  bumpLiveRevision(): void;
  setStatus(status: GraphWorkflowExecution["status"]): void;
}

function makeHarness(initial: GraphWorkflowExecution): Harness {
  let execution = initial;
  const liveEditApplied: PublishLiveEditAppliedInput[] = [];
  const charterUpdated: PublishCharterUpdatedInput[] = [];
  const charterWrites: { worktreePath: string; markdown: string }[] = [];
  const harness: Harness = {
    current: () => execution,
    liveEditApplied,
    charterUpdated,
    charterWrites,
    mutations: 0,
    library: new Map([
      ["general-implementer", hash("1")],
      ["general-reviewer", hash("2")],
      ["security-reviewer", SECURITY_V1],
    ]),
    prepareCalls: 0,
    beforeMutation: null,
    bumpLiveRevision: () => {
      execution = { ...execution, liveRevision: execution.liveRevision + 1 };
    },
    setStatus: (status) => {
      execution = { ...execution, status };
    },
    deps: {
      executionContract: createNonParticipatingGraphExecutionContract(),
      getActiveExecution: () => Promise.resolve(execution),
      mutateActive: (_projectPath, _sessionName, fn) => {
        harness.mutations += 1;
        harness.beforeMutation?.();
        return Promise.resolve(
          applyFixtureMutation(execution, fn, (next) => {
            execution = next;
          }),
        );
      },
      prepareAssignmentSnapshots: (_projectPath, operations) => {
        harness.prepareCalls += 1;
        return prepareLiveEditAssignmentSnapshots({
          operations,
          composeSnapshot: async (assignment) => {
            const hash = harness.library.get(assignment.profile.id);
            if (hash === undefined) {
              throw new AgentProfileNotResolvableError(assignment.profile);
            }
            return makeProfileSnapshot({
              tier: assignment.profile.tier,
              id: assignment.profile.id,
              resolvedInstructionHash: hash,
            });
          },
        });
      },
      buildLiveEditDeps: () => Promise.resolve(LIVE_EDIT_DEPS),
      publishLiveEditApplied: (input) => {
        liveEditApplied.push(input);
        return { events: [], pushes: [] };
      },
      publishCharterUpdated: (input) => {
        charterUpdated.push(input);
        return { events: [], pushes: [] };
      },
      getSession: () =>
        Promise.resolve({
          worktreePath: "/wt/session",
        } as unknown as SessionState),
      writeCharterDocument: (input) => {
        charterWrites.push(input);
        return Promise.resolve();
      },
    },
  };
  return harness;
}

function makeRequest(
  overrides: Partial<LiveEditApplyRequest> = {},
): LiveEditApplyRequest {
  return {
    executionId: "execution-1",
    baseLiveRevision: 1,
    source: "plan-repair",
    operations: [
      {
        type: "update-context",
        contextId: "context-implement",
        acceptanceCriteria: "Clarified, satisfiable criteria",
      },
    ],
    ...overrides,
  };
}

describe("applyLiveEditsToActiveExecution", () => {
  it("loads persisted execution authority before entering ordinary operation and frontier evaluation", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));
    const calls: string[] = [];
    harness.deps.executionContract = {
      loadPromptProjection: async () => null,

      validateDefinition: () => ({ ok: true }),
      loadLiveEdit: () => {
        calls.push("binding-loaded");
        return {
          validateOperation: () => {
            calls.push("operation-evaluated");
            return { ok: true };
          },
          accountabilityCoverageGroups: [],
        };
      },
      validateTaskCompletion: () => ({ ok: true }),
      deriveContextAcceptanceCriteria: () => ({
        ok: true,
        acceptanceCriteriaByContextId: {},
      }),
    };

    const outcome = await applyLiveEditsToActiveExecution(
      { projectPath: "/p", sessionName: "s", request: makeRequest() },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(["binding-loaded", "operation-evaluated"]);
  });

  it("applies a batch with the server-derived plan-repair source and bumps liveRevision once", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));

    const outcome = await applyLiveEditsToActiveExecution(
      { projectPath: "/p", sessionName: "s", request: makeRequest() },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.dryRun).toBe(false);
    expect(outcome.applied).toBe(1);
    expect(outcome.liveRevision).toBe(2);
    expect(harness.current().liveRevision).toBe(2);
    expect(harness.liveEditApplied).toHaveLength(1);
    expect(harness.liveEditApplied[0]?.source).toBe("plan-repair");
    const context = harness
      .current()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-implement",
      );
    expect(context?.acceptanceCriteria).toBe("Clarified, satisfiable criteria");
  });

  it("records a plan-repair-sourced charter amendment and rewrites the session charter.md", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({
          operations: [
            {
              type: "amend-charter",
              rationale: "AC referenced an endpoint removed in revision 2",
              mission: "Repair-amended mission",
            },
          ],
        }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    const amendment = harness.current().charterAmendments.at(-1);
    expect(amendment?.source).toBe("plan-repair");
    expect(amendment?.rationale).toBe(
      "AC referenced an endpoint removed in revision 2",
    );
    expect(harness.charterUpdated).toHaveLength(1);
    expect(harness.charterWrites).toHaveLength(1);
    expect(harness.charterWrites[0]?.worktreePath).toBe("/wt/session");
    expect(harness.charterWrites[0]?.markdown).toContain(
      "Repair-amended mission",
    );
  });

  it("dry-run validates without persisting or publishing", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({ dryRun: true }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.dryRun).toBe(true);
    expect(harness.mutations).toBe(0);
    expect(harness.liveEditApplied).toHaveLength(0);
    expect(harness.current().liveRevision).toBe(1);
  });

  it("rejects a stale baseLiveRevision with revision_conflict and persists nothing", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({ baseLiveRevision: 9 }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind !== "rejected") return;
    expect(outcome.failure.code).toBe("revision_conflict");
    expect(outcome.failure.status).toBe(409);
    expect(harness.current().liveRevision).toBe(1);
    expect(harness.liveEditApplied).toHaveLength(0);
  });

  it("commits the prepared snapshot verbatim when the profile is deleted between preparation and commit", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));
    // The operator's library edit lands inside the write queue's window, after
    // the bytes were composed and shown. The edit pins what it prepared.
    harness.beforeMutation = () => {
      harness.library.delete("security-reviewer");
    };

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({
          operations: [
            {
              type: "update-context",
              contextId: "context-implement",
              contextValidator: {
                enabled: true,
                assignments: [
                  makeValidatorAssignment({
                    id: "security",
                    profile: { tier: "project", id: "security-reviewer" },
                  }),
                ],
              },
            },
          ],
        }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    const cohort = harness
      .current()
      .workingDefinition.executionContexts.find(
        (entry) => entry.id === "context-implement",
      )?.contextValidator;
    expect(
      cohort?.assignments[0]?.profileSnapshot.resolvedInstructionHash,
    ).toBe(SECURITY_V1);
  });

  it("rejects a dangling profile reference at preparation, before the mutation opens", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));
    harness.library.delete("security-reviewer");

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({
          operations: [
            { type: "remove-task", taskId: "task-implement-1" },
            {
              type: "update-context",
              contextId: "context-implement",
              contextValidator: {
                enabled: true,
                assignments: [
                  makeValidatorAssignment({
                    id: "security",
                    profile: { tier: "project", id: "security-reviewer" },
                  }),
                ],
              },
            },
          ],
        }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "rejected") return;
    expect(outcome.failure.status).toBe(400);
    expect(outcome.failure.code).toBe("invalid_edit");
    expect(outcome.failure.issues).toEqual([
      expect.objectContaining({
        code: "profile-unresolvable",
        operationIndex: 1,
        contextId: "context-implement",
        field: "contextValidator.assignments[0]",
      }),
    ]);
    expect(harness.mutations).toBe(0);
    expect(harness.current().liveRevision).toBe(1);
  });

  it("returns the typed 409 when liveRevision moves under the prepared edit, and the retry re-prepares", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));
    const request = makeRequest({
      operations: [
        {
          type: "update-context",
          contextId: "context-implement",
          contextValidator: {
            enabled: true,
            assignments: [
              makeValidatorAssignment({
                id: "security",
                profile: { tier: "project", id: "security-reviewer" },
              }),
            ],
          },
        },
      ],
    });

    // A concurrent edit commits after this request prepared its snapshots but
    // before its own mutation runs, and it bumps the revision this batch was
    // authored against — and re-renders the profile while it is at it.
    harness.beforeMutation = () => {
      harness.beforeMutation = null;
      harness.library.set("security-reviewer", SECURITY_V2);
      harness.bumpLiveRevision();
    };

    const conflicted = await applyLiveEditsToActiveExecution(
      { projectPath: "/p", sessionName: "s", request },
      harness.deps,
    );
    expect(conflicted.ok).toBe(false);
    if (conflicted.ok || conflicted.kind !== "rejected") return;
    expect(conflicted.failure.code).toBe("revision_conflict");
    expect(conflicted.failure.status).toBe(409);
    expect(conflicted.failure.currentLiveRevision).toBe(2);
    expect(harness.prepareCalls).toBe(1);
    expect(harness.liveEditApplied).toHaveLength(0);

    const retried = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: { ...request, baseLiveRevision: 2 },
      },
      harness.deps,
    );

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    // The retry composed again rather than reusing the first attempt's bytes.
    expect(harness.prepareCalls).toBe(2);
    const cohort = retried.execution?.workingDefinition.executionContexts.find(
      (entry) => entry.id === "context-implement",
    )?.contextValidator;
    expect(
      cohort?.assignments[0]?.profileSnapshot.resolvedInstructionHash,
    ).toBe(SECURITY_V2);
  });

  it("applies a live edit when the execution pauses before the serialized mutation", async () => {
    const initial = createWorkflowExecution({
      status: "running",
      workingDefinition: createResolvedWorkflowDefinition({
        origin: { sourceUri: "spec-plan://spec-spine/attempt-1" },
      }),
    });
    initial.contextStates["context-implement"] = {
      ...initial.contextStates["context-implement"]!,
      status: "ready",
      iterationCount: 1,
    };
    initial.taskStates["task-implement-1"] = {
      ...initial.taskStates["task-implement-1"]!,
      status: "interrupted",
      startedAt: "2026-07-29T00:00:00.000Z",
    };
    const harness = makeHarness(initial);
    harness.beforeMutation = () => {
      harness.setStatus("paused");
    };

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({
          source: "cli",
          operations: [
            {
              type: "add-task",
              id: "task-added",
              contextId: "context-implement",
              title: "Added task",
              instructions: "Verify the paused live-edit path.",
            },
          ],
        }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.applied).toBe(1);
    expect(harness.current().status).toBe("paused");
    expect(harness.current().liveRevision).toBe(2);
    expect(
      harness.current().workingDefinition.tasks.map(({ id }) => id),
    ).toContain("task-added");
    expect(harness.liveEditApplied).toHaveLength(1);
  });

  it("keeps a running context's task list behind its mutability gate", async () => {
    const initial = createWorkflowExecution({
      status: "running",
      workingDefinition: createResolvedWorkflowDefinition({
        origin: { sourceUri: "spec-plan://spec-spine/attempt-1" },
      }),
    });
    initial.contextStates["context-implement"] = {
      ...initial.contextStates["context-implement"]!,
      status: "running",
    };
    const harness = makeHarness(initial);

    const outcome = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({
          source: "cli",
          operations: [
            {
              type: "add-task",
              id: "task-added",
              contextId: "context-implement",
              title: "Added task",
              instructions: "Do work the running context did not start with.",
            },
          ],
        }),
      },
      harness.deps,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok || outcome.kind !== "rejected") return;
    expect(outcome.failure.code).toBe("requires_pause");
    expect(harness.current().workingDefinition.tasks).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "task-added" })]),
    );
  });

  it("reports a missing active execution distinctly", async () => {
    const harness = makeHarness(createWorkflowExecution({ status: "paused" }));
    harness.deps.getActiveExecution = () => Promise.resolve(null);
    harness.deps.mutateActive = () =>
      Promise.reject(
        new Error("Session does not have an active graph workflow execution"),
      );

    const dryRun = await applyLiveEditsToActiveExecution(
      {
        projectPath: "/p",
        sessionName: "s",
        request: makeRequest({ dryRun: true }),
      },
      harness.deps,
    );
    expect(dryRun).toEqual({ ok: false, kind: "no_active_execution" });

    const apply = await applyLiveEditsToActiveExecution(
      { projectPath: "/p", sessionName: "s", request: makeRequest() },
      harness.deps,
    );
    expect(apply).toEqual({ ok: false, kind: "no_active_execution" });
  });
});
