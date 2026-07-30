import { describe, expect, it } from "vitest";
import { createWorkflowExecution } from "./test-fixtures";
import {
  applyLiveEditsToActiveExecution,
  type LiveEditApplyRequest,
  type LiveEditApplyServiceDeps,
} from "./live-edit-apply";
import type { LiveEditDeps, ResolvedContextConfig } from "./runtime-edits";
import type { GraphWorkflowExecution } from "./schemas";
import type {
  PublishCharterUpdatedInput,
  PublishLiveEditAppliedInput,
} from "./execution-events";
import type { MutateActiveResult } from "./execution-repository";
import type { SessionState } from "@/lib/sessions/schemas";

const RESOLVED_DEFAULTS: ResolvedContextConfig = {
  implementer: { backend: "claude", model: "opus", reasoningEffort: "medium" },
  contextValidator: null,
  scriptValidator: { enabled: false },
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
};

const LIVE_EDIT_DEPS: LiveEditDeps = {
  createTaskId: () => "task-minted-1",
  resolvedGlobalDefaults: () => RESOLVED_DEFAULTS,
  hasPreMergeCommand: () => true,
  now: () => "2026-07-29T00:00:00.000Z",
};

interface Harness {
  deps: LiveEditApplyServiceDeps;
  current(): GraphWorkflowExecution;
  liveEditApplied: PublishLiveEditAppliedInput[];
  charterUpdated: PublishCharterUpdatedInput[];
  charterWrites: { worktreePath: string; markdown: string }[];
  mutations: number;
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
    deps: {
      getActiveExecution: () => Promise.resolve(execution),
      mutateActive: (_projectPath, _sessionName, fn) => {
        harness.mutations += 1;
        const result = fn(execution) as
          | MutateActiveResult
          | GraphWorkflowExecution;
        execution = "execution" in result ? result.execution : result;
        return Promise.resolve(execution);
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
    expect(context?.acceptanceCriteria).toBe(
      "Clarified, satisfiable criteria",
    );
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
