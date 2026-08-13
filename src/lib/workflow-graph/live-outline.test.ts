import { describe, expect, it } from "vitest";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { resolvedWorkflowSemanticDefinitionSchema } from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import {
  buildInitialContextStates,
  buildInitialTaskStates,
} from "./execution-state";
import { projectLiveOutline } from "./live-outline";
import { makeProfileSnapshot } from "./test-fixtures";

/**
 * A three-context execution mirroring the doc-06 outline example: `plan`
 * (completed → frozen), `impl` (running → started), `verify` (pristine pending →
 * unstarted), wired plan → impl → verify.
 */
const workingDefinition = resolvedWorkflowSemanticDefinitionSchema.parse({
  schemaVersion: 1,
  executionContexts: [
    {
      id: "plan",
      title: "Plan the work",
      description: "Lay out the approach",
      acceptanceCriteria: "A plan exists",
      placement: { lane: "plan", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
      },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot({
              tier: "builtin",
              id: "general-reviewer",
            }),
            strategy: "conversation",
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
      scriptValidator: { commands: [] },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    },
    {
      id: "impl",
      title: "Build inspector UI",
      acceptanceCriteria: "UI ships",
      placement: { lane: "impl", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "medium",
        },
      },
      contextValidator: {
        enabled: true,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            profileSnapshot: makeProfileSnapshot({
              tier: "builtin",
              id: "general-reviewer",
            }),
            strategy: "conversation",
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: true },
          },
        ],
      },
      scriptValidator: { commands: ["pre-merge"] },
      humanApprovalGate: { enabled: true },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    },
    {
      id: "verify",
      title: "Verify",
      acceptanceCriteria: "All green",
      placement: { lane: "verify", mode: "full" },
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
      },
      // A DISABLED cohort that retains its assignment: the shape disabling
      // produces, since turning validation off is lossless. Execution start
      // snapshots dormant assignments too, so the outline has one to report.
      contextValidator: {
        enabled: false,
        assignments: [
          {
            id: "dormant-security",
            // Reference and snapshot deliberately DISAGREE, so a summary that
            // reads the reference is distinguishable from one that reads the
            // bytes the lane would replay.
            profile: { tier: "global", id: "stale-reference" },
            profileSnapshot: makeProfileSnapshot({
              tier: "builtin",
              id: "general-reviewer",
              revision: 4,
            }),
            strategy: "task",
            agent: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "low",
            },
            continuity: { enabled: false },
          },
        ],
      },
      scriptValidator: { commands: [] },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
      circuitBreaker: {},
      iterationPolicy: { maxIterations: 12, continuity: { enabled: true } },
    },
  ],
  tasks: [
    {
      id: "plan-a",
      contextId: "plan",
      order: 1,
      title: "Sketch",
      instructions: "x".repeat(200),
      source: "user",
    },
    {
      id: "impl-api",
      contextId: "impl",
      order: 1,
      title: "Wire API",
      instructions: "x".repeat(812),
      source: "user",
    },
    {
      id: "impl-ui",
      contextId: "impl",
      order: 2,
      title: "Build inspector UI",
      instructions: "x".repeat(1800),
      source: "user",
    },
    {
      id: "impl-tests",
      contextId: "impl",
      order: 3,
      title: "Add tests",
      instructions: "x".repeat(704),
      source: "user",
    },
    {
      id: "verify-a",
      contextId: "verify",
      order: 1,
      title: "Run checks",
      instructions: "x".repeat(100),
      source: "user",
    },
    {
      id: "verify-b",
      contextId: "verify",
      order: 2,
      title: "Report",
      instructions: "x".repeat(50),
      source: "user",
    },
  ],
  edges: [
    { id: "e1", sourceContextId: "plan", targetContextId: "impl" },
    { id: "e2", sourceContextId: "impl", targetContextId: "verify" },
  ],
});

interface FixtureOverrides {
  status?: GraphWorkflowStatus;
  haltReason?: GraphWorkflowHaltReason | null;
}

function buildExecution(
  overrides: FixtureOverrides = {},
): GraphWorkflowExecution {
  const contextStates = buildInitialContextStates(workingDefinition);
  const taskStates = buildInitialTaskStates(workingDefinition);

  // plan: completed (frozen) — 3/3 (its one task done + counted), iter 2.
  contextStates["plan"] = {
    ...contextStates["plan"]!,
    status: "completed",
    completedTaskCount: 1,
    totalTaskCount: 1,
    iterationCount: 2,
  };
  taskStates["plan-a"] = { ...taskStates["plan-a"]!, status: "completed" };

  // impl: running (started) — 1/4 tasks, iter 3.
  contextStates["impl"] = {
    ...contextStates["impl"]!,
    status: "running",
    completedTaskCount: 1,
    iterationCount: 3,
  };
  taskStates["impl-api"] = { ...taskStates["impl-api"]!, status: "completed" };
  taskStates["impl-ui"] = { ...taskStates["impl-ui"]!, status: "running" };

  return graphWorkflowExecutionSchema.parse({
    id: "exec-7",
    seedDefinitionId: "wf-1",
    seedDefinitionRevision: 12,
    liveRevision: 4,
    workingDefinition,
    charter: makeTestCharter(),
    status: overrides.status ?? "running",
    activeContextIds: overrides.status === "paused" ? [] : ["impl"],
    contextStates,
    taskStates,
    startedAt: "2026-01-01T00:00:00Z",
    haltReason: overrides.haltReason ?? null,
  });
}

describe("projectLiveOutline — header", () => {
  it("carries executionId, liveRevision, status, and seed id@revision", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    expect(result.ok).toBe(true);
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.header).toMatchObject({
      executionId: "exec-7",
      liveRevision: 4,
      status: "running",
      seedDefinitionId: "wf-1",
      seedDefinitionRevision: 12,
      editable: true,
    });
    expect(result.outline.header.notEditableReason).toBeUndefined();
  });

  it("marks editable:false with a reason for a completed execution", () => {
    const result = projectLiveOutline(buildExecution({ status: "completed" }), {
      kind: "outline",
    });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.header.editable).toBe(false);
    expect(result.outline.header.notEditableReason).toBe("completed");
  });

  it("marks editable:false for an aborted execution", () => {
    const result = projectLiveOutline(buildExecution({ status: "aborted" }), {
      kind: "outline",
    });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.header.editable).toBe(false);
    expect(result.outline.header.notEditableReason).toBe("aborted");
  });

  it("marks editable:false for a non-resumable halt (recovery_error)", () => {
    const result = projectLiveOutline(
      buildExecution({
        status: "halted",
        haltReason: { type: "recovery_error", message: "boom" },
      }),
      { kind: "outline" },
    );
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.header.editable).toBe(false);
    expect(result.outline.header.notEditableReason).toBe("halt-not-resumable");
  });

  it("stays editable for a resumable halt (max_iterations)", () => {
    const result = projectLiveOutline(
      buildExecution({
        status: "halted",
        haltReason: {
          type: "max_iterations",
          contextId: "impl",
          iterationCount: 20,
          summary: null,
        },
      }),
      { kind: "outline" },
    );
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.header.editable).toBe(true);
  });
});

describe("projectLiveOutline — context rows", () => {
  it("resolves editability tiers against a running execution", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.contexts.map((c) => [c.id, c]),
    );
    expect(byId["plan"]!.editability).toBe("frozen");
    expect(byId["impl"]!.editability).toBe("pause-to-edit");
    expect(byId["verify"]!.editability).toBe("editable");
  });

  it("keeps a dependency-waiting context editable after its reservation is cleared", () => {
    const execution = buildExecution();
    execution.contextStates["verify"]!.reservedByBatchId = null;
    execution.contextStates["verify"]!.reservedOwnership = null;

    const result = projectLiveOutline(execution, { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.contexts.map((context) => [context.id, context]),
    );

    expect(byId["verify"]!.editability).toBe("editable");
  });

  it("resolves a started context to editable on a paused (quiescent) execution", () => {
    const result = projectLiveOutline(buildExecution({ status: "paused" }), {
      kind: "outline",
    });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.contexts.map((c) => [c.id, c]),
    );
    // plan stays frozen (completed); impl is started → editable when quiescent.
    expect(byId["plan"]!.editability).toBe("frozen");
    expect(byId["impl"]!.editability).toBe("editable");
    expect(byId["verify"]!.editability).toBe("editable");
  });

  it("reports deps (upstream context ids), task progress, and iteration progress", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.contexts.map((c) => [c.id, c]),
    );
    expect(byId["plan"]).toMatchObject({
      deps: [],
      completedTaskCount: 1,
      totalTaskCount: 1,
      iterationCount: 2,
      maxIterations: 20,
      status: "completed",
    });
    expect(byId["impl"]).toMatchObject({
      deps: ["plan"],
      completedTaskCount: 1,
      totalTaskCount: 3,
      iterationCount: 3,
      maxIterations: 20,
      status: "running",
    });
    expect(byId["verify"]).toMatchObject({
      deps: ["impl"],
      completedTaskCount: 0,
      totalTaskCount: 2,
      iterationCount: 0,
      maxIterations: 12,
      status: "pending",
    });
  });

  it("orders contexts by their definition order", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.contexts.map((c) => c.id)).toEqual([
      "plan",
      "impl",
      "verify",
    ]);
  });
});

describe("projectLiveOutline — task rows", () => {
  it("sizes instructions instead of inlining them, ordered by context then order", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const impl = result.outline.tasks.filter((t) => t.contextId === "impl");
    expect(impl.map((t) => t.id)).toEqual([
      "impl-api",
      "impl-ui",
      "impl-tests",
    ]);
    expect(impl[0]).toMatchObject({
      contextId: "impl",
      order: 1,
      id: "impl-api",
      status: "completed",
      title: "Wire API",
      instructionChars: 812,
    });
    expect(impl[1]).toMatchObject({
      status: "running",
      instructionChars: 1800,
    });
    // No inlined instructions anywhere in the sized rows.
    for (const task of result.outline.tasks) {
      expect(task).not.toHaveProperty("instructions");
    }
  });
});

describe("projectLiveOutline — config summaries", () => {
  it("summarizes implementer, validator, and gates per context", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.config.map((c) => [c.contextId, c]),
    );
    expect(byId["plan"]).toMatchObject({
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      validators: [
        {
          assignmentId: "general",
          profile: "builtin:general-reviewer",
          strategy: "conversation",
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      ],
      scriptValidator: { commands: [] },
      humanApprovalGate: false,
      askUserQuestions: false,
      // Contexts resolved before the selector snapshot existed carry none.
      agentValidation: null,
    });
    expect(byId["impl"]).toMatchObject({
      scriptValidator: { commands: ["pre-merge"] },
      humanApprovalGate: true,
    });
    // verify: codex implementer, cohort disabled — but its dormant assignment
    // is still reported, flagged by the cohort switch rather than dropped.
    expect(byId["verify"]).toMatchObject({
      implementer: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      validatorCohortEnabled: false,
      validators: [{ assignmentId: "dormant-security", strategy: "task" }],
    });
  });

  it("carries concrete command selections when the snapshot declares them", () => {
    const execution = buildExecution();
    execution.workingDefinition = {
      ...execution.workingDefinition,
      executionContexts: execution.workingDefinition.executionContexts.map(
        (context) =>
          context.id === "impl"
            ? {
                ...context,
                scriptValidator: {
                  commands: ["typecheck", "test"],
                },
                agentValidation: {
                  implementer: {
                    value: { mode: "all", except: ["format"] },
                    source: "workflow",
                  },
                  contextValidator: {
                    value: { mode: "only", commands: [] },
                    source: "global",
                  },
                },
              }
            : context,
      ),
    };

    const result = projectLiveOutline(execution, { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const impl = result.outline.config.find((c) => c.contextId === "impl");
    expect(impl).toMatchObject({
      scriptValidator: { commands: ["typecheck", "test"] },
      agentValidation: {
        implementer: { mode: "all", except: ["format"] },
        contextValidator: { mode: "only", commands: [] },
      },
    });

    // The full-config selector returns the resolved snapshot verbatim so a
    // live edit can address it.
    const slice = projectLiveOutline(execution, {
      kind: "context",
      contextId: "impl",
    });
    if (!slice.ok || slice.section !== "context")
      throw new Error("expected context");
    expect(slice.context.config.scriptValidator).toEqual({
      commands: ["typecheck", "test"],
    });
    expect(slice.context.config.agentValidation).toEqual({
      implementer: {
        value: { mode: "all", except: ["format"] },
        source: "workflow",
      },
      contextValidator: {
        value: { mode: "only", commands: [] },
        source: "global",
      },
    });
  });

  it("projects the workflow-scope lane-merge validation snapshot", () => {
    const execution = buildExecution();
    execution.workingDefinition = {
      ...execution.workingDefinition,
      laneMergeValidation: {
        strategy: "final-only",
        commands: { mode: "project" },
      },
    };
    const result = projectLiveOutline(execution, { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.laneMergeValidation).toEqual({
      strategy: "final-only",
      commands: { mode: "project" },
    });
  });

  it("projects null lane-merge validation for executions seeded before the snapshot", () => {
    const execution = buildExecution();
    const legacyWorkingDefinition = execution.workingDefinition as Partial<
      typeof execution.workingDefinition
    >;
    delete legacyWorkingDefinition.laneMergeValidation;
    const result = projectLiveOutline(execution, { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(result.outline.laneMergeValidation).toBeNull();
  });

  /**
   * R13.1: a disabled cohort's assignments are SEEDED — start snapshotted them
   * so a mid-run edit can enable one without a library lookup. Dropping them
   * from the outline would make "turn validation back on" a blind operation on
   * the one surface that shows what a running execution holds.
   */
  it("reports the dormant assignments of a disabled cohort", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const verify = result.outline.config.find((c) => c.contextId === "verify");

    expect(verify?.validatorCohortEnabled).toBe(false);
    expect(verify?.validators).toHaveLength(1);
    expect(verify?.validators[0]).toMatchObject({
      assignmentId: "dormant-security",
      revision: 4,
      backend: "codex",
    });
  });

  /**
   * The snapshot is the side that RAN. A reference can only disagree with it if
   * something bypassed seeding, and in that case the reference is the wrong
   * answer — so provenance is read from the snapshot, never the reference.
   */
  it("derives the profile from the snapshot, not the authored reference", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const verify = result.outline.config.find((c) => c.contextId === "verify");

    expect(verify?.validators[0]?.profile).toBe("builtin:general-reviewer");
    expect(verify?.validators[0]?.profile).not.toBe("global:stale-reference");
  });

  /**
   * R13.1: a LIVE execution is SNAPSHOT-bearing. Its assignments were resolved
   * once at start and nothing consults the library again, so the outline
   * reports the seeded revision and the resolved-instruction hash — the two
   * values that say what is actually running, as opposed to the bare reference
   * a saved definition carries.
   */
  it("carries seeded snapshot provenance on every assignment summary", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const byId = Object.fromEntries(
      result.outline.config.map((c) => [c.contextId, c]),
    );

    expect(byId["plan"]?.implementer).toMatchObject({
      assignmentId: "implementer",
      profile: "builtin:general-implementer",
      revision: 1,
      resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
    });
    expect(byId["plan"]?.validators[0]).toMatchObject({
      assignmentId: "general",
      profile: "builtin:general-reviewer",
      revision: 1,
      resolvedInstructionHash: `sha256:${"b".repeat(64)}`,
    });
  });

  it("keeps instruction text out of the outline summaries", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");

    for (const entry of result.outline.config) {
      for (const summary of [entry.implementer, ...entry.validators]) {
        expect(summary).not.toHaveProperty("instructions");
        expect(summary).not.toHaveProperty("renderedInstructionBlock");
      }
    }
  });
});

describe("projectLiveOutline — section selectors", () => {
  it("context: returns full prose + resolved config + full task instructions", () => {
    const result = projectLiveOutline(buildExecution(), {
      kind: "context",
      contextId: "impl",
    });
    if (!result.ok || result.section !== "context")
      throw new Error("expected context");
    expect(result.context).toMatchObject({
      id: "impl",
      title: "Build inspector UI",
      acceptanceCriteria: "UI ships",
      editability: "pause-to-edit",
      deps: ["plan"],
    });
    // Full resolved config (doc 06): concrete blocks, not the compact summary.
    expect(result.context.config.scriptValidator).toEqual({
      commands: ["pre-merge"],
    });
    expect(result.context.config.humanApprovalGate).toEqual({ enabled: true });
    expect(result.context.config.iterationPolicy.maxIterations).toBe(20);
    expect(result.context.config.circuitBreaker).toBeDefined();
    expect(result.context.config.mutability).toEqual({
      allowAgentTaskAdd: false,
      allowAgentContextAdd: false,
    });
    expect(result.context.config.contextValidator).toMatchObject({
      enabled: true,
      assignments: [{ id: "general", strategy: "conversation" }],
    });
    const apiTask = result.context.tasks.find((t) => t.id === "impl-api");
    expect(apiTask?.instructions).toHaveLength(812);
  });

  it("task: returns one task's full instructions", () => {
    const result = projectLiveOutline(buildExecution(), {
      kind: "task",
      taskId: "impl-ui",
    });
    if (!result.ok || result.section !== "task")
      throw new Error("expected task");
    expect(result.task).toMatchObject({
      id: "impl-ui",
      contextId: "impl",
      order: 2,
      title: "Build inspector UI",
      status: "running",
    });
    expect(result.task.instructions).toHaveLength(1800);
  });

  it("config: returns one context's FULL resolved config (concrete blocks)", () => {
    const result = projectLiveOutline(buildExecution(), {
      kind: "config",
      contextId: "verify",
    });
    if (!result.ok || result.section !== "config")
      throw new Error("expected config");
    expect(result.config).toMatchObject({
      contextId: "verify",
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        profileSnapshot: makeProfileSnapshot(),
        agent: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
        },
      },
      // The raw section returns the resolved cohort verbatim, dormant
      // assignments included — they are configuration a live edit can enable.
      contextValidator: {
        enabled: false,
        assignments: [{ id: "dormant-security" }],
      },
      scriptValidator: { commands: [] },
      humanApprovalGate: { enabled: false },
      askUserQuestions: { enabled: false },
      mutability: { allowAgentTaskAdd: false },
    });
    // The full config exposes the runtime policy blocks the compact summary omits.
    expect(result.config.iterationPolicy.maxIterations).toBe(12);
    expect(result.config.circuitBreaker).toBeDefined();
  });

  it("full: expands every context with prose + config + full tasks", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "full" });
    if (!result.ok || result.section !== "full")
      throw new Error("expected full");
    expect(result.header.executionId).toBe("exec-7");
    expect(result.contexts.map((c) => c.id)).toEqual([
      "plan",
      "impl",
      "verify",
    ]);
    const impl = result.contexts.find((c) => c.id === "impl");
    expect(impl?.tasks.map((t) => t.id)).toEqual([
      "impl-api",
      "impl-ui",
      "impl-tests",
    ]);
    expect(impl?.tasks[0]?.instructions).toHaveLength(812);
  });

  it("returns ok:false for an unknown context selector", () => {
    const result = projectLiveOutline(buildExecution(), {
      kind: "context",
      contextId: "nope",
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok:false for an unknown task selector", () => {
    const result = projectLiveOutline(buildExecution(), {
      kind: "task",
      taskId: "nope",
    });
    expect(result.ok).toBe(false);
  });
});

describe("projectLiveOutline — outputSchema in the resolved config (R6.2)", () => {
  const OUTPUT_SCHEMA = {
    type: "object",
    required: ["verdict"],
    additionalProperties: false,
    properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
  };

  /** The doc-06 fixture with a declared output contract on `verify` only. */
  function executionWithOutputSchema(): GraphWorkflowExecution {
    const base = buildExecution();
    return graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "verify"
              ? { ...context, outputSchema: OUTPUT_SCHEMA }
              : context,
        ),
      }),
    });
  }

  it("config: returns a declared outputSchema verbatim", () => {
    const result = projectLiveOutline(executionWithOutputSchema(), {
      kind: "config",
      contextId: "verify",
    });
    if (!result.ok || result.section !== "config")
      throw new Error("expected config");
    expect(result.config.outputSchema).toEqual(OUTPUT_SCHEMA);
  });

  it("context and full selectors carry the same declaration", () => {
    const execution = executionWithOutputSchema();

    const context = projectLiveOutline(execution, {
      kind: "context",
      contextId: "verify",
    });
    if (!context.ok || context.section !== "context")
      throw new Error("expected context");
    expect(context.context.config.outputSchema).toEqual(OUTPUT_SCHEMA);

    const full = projectLiveOutline(execution, { kind: "full" });
    if (!full.ok || full.section !== "full") throw new Error("expected full");
    expect(
      full.contexts.find((entry) => entry.id === "verify")?.config.outputSchema,
    ).toEqual(OUTPUT_SCHEMA);
  });

  it("omits the key entirely on a context that declares none", () => {
    const result = projectLiveOutline(executionWithOutputSchema(), {
      kind: "config",
      contextId: "impl",
    });
    if (!result.ok || result.section !== "config")
      throw new Error("expected config");
    expect(result.config).not.toHaveProperty("outputSchema");
  });

  it("outline rows carry a presence SUMMARY (shape), never the declaration", () => {
    const result = projectLiveOutline(executionWithOutputSchema(), {
      kind: "outline",
    });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    const verify = result.outline.contexts.find((c) => c.id === "verify");
    const impl = result.outline.contexts.find((c) => c.id === "impl");
    if (!verify || !impl) throw new Error("expected verify and impl rows");
    expect(verify.outputSchema).toEqual({ type: "object", fieldCount: 1 });
    expect(impl.outputSchema).toBeNull();
    // The row sizes the contract; the body stays section-tier only.
    expect(JSON.stringify(verify)).not.toContain("additionalProperties");
  });

  it("reports a null fieldCount for a root that declares no properties", () => {
    const base = buildExecution();
    const execution = graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "verify"
              ? { ...context, outputSchema: { type: "object" } }
              : context,
        ),
      }),
    });
    const result = projectLiveOutline(execution, { kind: "outline" });
    if (!result.ok || result.section !== "outline")
      throw new Error("expected outline");
    expect(
      result.outline.contexts.find((c) => c.id === "verify")?.outputSchema,
    ).toEqual({ type: "object", fieldCount: null });
  });
});

describe("projectLiveOutline — outputs selector (R7.2)", () => {
  const OUTPUT_SCHEMA = {
    type: "object",
    required: ["verdict"],
    properties: {
      verdict: { type: "string", enum: ["pass", "fail"] },
      notes: { type: "string" },
    },
  };

  /**
   * `plan` declared a contract and CAPTURED it; `verify` declares one and still
   * owes it; `impl` declares none at all — the three states the outputs read
   * must keep distinct.
   */
  function executionWithOutputs(): GraphWorkflowExecution {
    const base = buildExecution();
    return graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "plan" || context.id === "verify"
              ? { ...context, outputSchema: OUTPUT_SCHEMA }
              : context,
        ),
      }),
      contextOutputs: {
        plan: {
          value: { verdict: "pass", notes: "all green" },
          capturedAt: "2026-07-30T10:00:00.000Z",
          iteration: 2,
          parse: { source: "fenced", repaired: true, repairAttempts: 1 },
        },
      },
    });
  }

  it("returns the captured payload with its parse provenance", () => {
    const result = projectLiveOutline(executionWithOutputs(), {
      kind: "outputs",
    });
    if (!result.ok || result.section !== "outputs")
      throw new Error("expected outputs");
    const plan = result.outputs.find((entry) => entry.contextId === "plan");
    expect(plan).toEqual({
      contextId: "plan",
      title: "Plan the work",
      status: "completed",
      schema: { type: "object", fieldCount: 2 },
      capture: {
        kind: "captured",
        value: { verdict: "pass", notes: "all green" },
        capturedAt: "2026-07-30T10:00:00.000Z",
        iteration: 2,
        parse: { source: "fenced", repaired: true, repairAttempts: 1 },
      },
    });
  });

  it("reports a declared-but-unproduced context as pending", () => {
    const result = projectLiveOutline(executionWithOutputs(), {
      kind: "outputs",
    });
    if (!result.ok || result.section !== "outputs")
      throw new Error("expected outputs");
    const verify = result.outputs.find((entry) => entry.contextId === "verify");
    expect(verify).toEqual({
      contextId: "verify",
      title: "Verify",
      status: "pending",
      schema: { type: "object", fieldCount: 2 },
      capture: { kind: "pending" },
    });
  });

  it("omits contexts that declare no outputSchema and banked nothing", () => {
    const result = projectLiveOutline(executionWithOutputs(), {
      kind: "outputs",
    });
    if (!result.ok || result.section !== "outputs")
      throw new Error("expected outputs");
    expect(result.outputs.map((entry) => entry.contextId)).toEqual([
      "plan",
      "verify",
    ]);
  });

  it("still surfaces a banked output after its declaration was cleared", () => {
    const base = executionWithOutputs();
    const cleared = graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) => {
            if (context.id !== "plan") return context;
            const { outputSchema: _dropped, ...rest } = context;
            return rest;
          },
        ),
      }),
    });
    const result = projectLiveOutline(cleared, { kind: "outputs" });
    if (!result.ok || result.section !== "outputs")
      throw new Error("expected outputs");
    const plan = result.outputs.find((entry) => entry.contextId === "plan");
    expect(plan?.schema).toBeNull();
    expect(plan?.capture.kind).toBe("captured");
  });

  it("returns an empty list when no context declares an outputSchema", () => {
    const result = projectLiveOutline(buildExecution(), { kind: "outputs" });
    if (!result.ok || result.section !== "outputs")
      throw new Error("expected outputs");
    expect(result.outputs).toEqual([]);
  });
});

describe("projectLiveOutline — charter selector (doc 07)", () => {
  const amendments = [
    {
      seq: 1,
      amendedAt: "2026-07-29T10:00:00.000Z",
      source: "cli" as const,
      rationale: "Invariant inv-2 was impossible against the shipped API",
      fieldsChanged: ["invariants"],
      charterHash: "hash-after-1",
    },
  ];

  it("returns the rendered charter markdown with the amendment log and structured entries", () => {
    const execution: GraphWorkflowExecution = {
      ...buildExecution({ status: "paused" }),
      charterAmendments: amendments,
    };
    const result = projectLiveOutline(execution, { kind: "charter" });

    expect(result.ok && result.section === "charter").toBe(true);
    if (!result.ok || result.section !== "charter") return;
    expect(result.charter.markdown).toContain("# Workflow Charter");
    expect(result.charter.markdown).toContain("## Amendment log");
    expect(result.charter.markdown).toContain(
      "Invariant inv-2 was impossible against the shipped API",
    );
    expect(result.charter.amendments).toEqual(amendments);
    expect(result.charter.charterHash.length).toBeGreaterThan(0);
  });

  it("counts amendments in the outline header", () => {
    const pristine = projectLiveOutline(buildExecution(), { kind: "outline" });
    expect(pristine.ok).toBe(true);
    if (!pristine.ok || pristine.section !== "outline") return;
    expect(pristine.outline.header.charterAmendmentCount).toBe(0);

    const amended = projectLiveOutline(
      { ...buildExecution(), charterAmendments: amendments },
      { kind: "outline" },
    );
    expect(amended.ok).toBe(true);
    if (!amended.ok || amended.section !== "outline") return;
    expect(amended.outline.header.charterAmendmentCount).toBe(1);
  });
});

// ============================================================
// D4 read surfaces (R13.2)
// ============================================================

function outlineOf(execution: GraphWorkflowExecution) {
  const result = projectLiveOutline(execution, { kind: "outline" });
  if (!result.ok || result.section !== "outline") {
    throw new Error("expected outline");
  }
  return result.outline;
}

describe("projectLiveOutline — edge guards (R13.2)", () => {
  function guardedExecution(): GraphWorkflowExecution {
    const base = buildExecution();
    return graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "plan"
              ? {
                  ...context,
                  outputSchema: {
                    type: "object",
                    properties: { verdict: { type: "string" } },
                  },
                }
              : context,
        ),
        edges: [
          {
            id: "e1",
            sourceContextId: "plan",
            targetContextId: "impl",
            when: {
              schema: { properties: { verdict: { const: "broken" } } },
            },
          },
          { id: "e2", sourceContextId: "impl", targetContextId: "verify" },
        ],
      }),
      contextOutputs: {
        plan: {
          value: { verdict: "broken" },
          capturedAt: "2026-01-01T01:00:00Z",
          iteration: 1,
          parse: { source: "native" },
        },
      },
    });
  }

  it("reports each route's guard kind and resolved verdict", () => {
    const routes = outlineOf(guardedExecution()).routes;

    expect(routes).toEqual([
      {
        id: "e1",
        source: "plan",
        effectiveSource: "plan",
        target: "impl",
        guard: "schema",
        resolution: "active",
      },
      // An ordinary edge keeps its logical source as the effective one even
      // while unresolved — only a loop's external edge ever retargets.
      {
        id: "e2",
        source: "impl",
        effectiveSource: "impl",
        target: "verify",
        guard: "none",
        resolution: "unresolved",
      },
    ]);
  });

  it("reports an unguarded graph's routes with guard none", () => {
    expect(
      outlineOf(buildExecution()).routes.every(
        (route) => route.guard === "none",
      ),
    ).toBe(true);
  });
});

describe("projectLiveOutline — skip states (R13.2)", () => {
  it("carries the recorded skip verdicts on the context row", () => {
    const base = buildExecution();
    const execution = graphWorkflowExecutionSchema.parse({
      ...base,
      contextStates: {
        ...base.contextStates,
        verify: {
          ...base.contextStates["verify"]!,
          status: "skipped",
          skipReason: {
            at: "2026-01-01T02:00:00Z",
            edgeEvaluations: [{ edgeId: "e2", verdict: "inactive" }],
          },
        },
      },
    });

    const row = outlineOf(execution).contexts.find((c) => c.id === "verify");
    expect(row?.status).toBe("skipped");
    expect(row?.skip).toEqual({
      at: "2026-01-01T02:00:00Z",
      edgeEvaluations: [{ edgeId: "e2", verdict: "inactive" }],
    });
  });

  it("leaves skip null on a context that was not skipped", () => {
    expect(
      outlineOf(buildExecution()).contexts.every((row) => row.skip === null),
    ).toBe(true);
  });

  it("reports a skipped context's declared contract as skipped, never pending", () => {
    const base = buildExecution();
    const execution = graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: resolvedWorkflowSemanticDefinitionSchema.parse({
        ...base.workingDefinition,
        executionContexts: base.workingDefinition.executionContexts.map(
          (context) =>
            context.id === "verify"
              ? {
                  ...context,
                  outputSchema: { type: "object", properties: {} },
                }
              : context,
        ),
      }),
      contextStates: {
        ...base.contextStates,
        verify: {
          ...base.contextStates["verify"]!,
          status: "skipped",
          skipReason: {
            at: "2026-01-01T02:00:00Z",
            edgeEvaluations: [{ edgeId: "e2", verdict: "inactive" }],
          },
        },
      },
    });

    const result = projectLiveOutline(execution, { kind: "outputs" });
    if (!result.ok || result.section !== "outputs") {
      throw new Error("expected outputs");
    }
    expect(
      result.outputs.find((row) => row.contextId === "verify")?.capture,
    ).toEqual({ kind: "skipped" });
  });
});

describe("projectLiveOutline — loop passes and budgets (R13.2)", () => {
  function loopExecution(): GraphWorkflowExecution {
    const base = buildExecution();
    const [plan, impl, verify] = base.workingDefinition.executionContexts;
    const definition = resolvedWorkflowSemanticDefinitionSchema.parse({
      ...base.workingDefinition,
      executionContexts: [
        plan,
        { ...impl, id: "loop-a__p2__impl" },
        { ...verify, id: "loop-a__p2__verify" },
      ],
      tasks: [],
      edges: [
        { id: "e1", sourceContextId: "plan", targetContextId: "impl" },
        { id: "e2", sourceContextId: "verify", targetContextId: "plan" },
      ],
      loopGroups: [
        {
          id: "loop-a",
          entryContextId: "impl",
          exitContextId: "verify",
          until: { schema: { properties: { done: { const: true } } } },
          maxPasses: 4,
          templateVersion: 2,
          template: { contexts: [impl, verify], tasks: [], edges: [] },
          planRepair: { enabled: false },
        },
      ],
    });
    return graphWorkflowExecutionSchema.parse({
      ...base,
      workingDefinition: definition,
      contextStates: {
        plan: base.contextStates["plan"],
        "loop-a__p2__impl": {
          ...base.contextStates["impl"]!,
          contextId: "loop-a__p2__impl",
        },
        "loop-a__p2__verify": {
          ...base.contextStates["verify"]!,
          contextId: "loop-a__p2__verify",
        },
      },
      taskStates: {},
      activeContextIds: [],
      loopStates: {
        "loop-a": {
          loopGroupId: "loop-a",
          activation: "concluded",
          loopControlRevision: 1,
          passCount: 2,
          slotLedger: [],
          decisions: {},
          passTemplateVersions: { "1": 1, "2": 2 },
          concludingExitContextId: "loop-a__p2__verify",
          activatedAt: "2026-01-01T00:30:00Z",
          settledAt: "2026-01-01T03:00:00Z",
        },
      },
    });
  }

  it("reports each loop's activation, pass counter and budget", () => {
    expect(outlineOf(loopExecution()).loops).toEqual([
      {
        loopGroupId: "loop-a",
        activation: "concluded",
        passCount: 2,
        maxPasses: 4,
        loopControlRevision: 1,
        logicalExitContextId: "verify",
        concludingExitContextId: "loop-a__p2__verify",
      },
    ]);
  });

  it("badges a pass instance's row with its pass, budget and template version", () => {
    const row = outlineOf(loopExecution()).contexts.find(
      (c) => c.id === "loop-a__p2__impl",
    );
    expect(row?.loop).toEqual({
      loopGroupId: "loop-a",
      pass: 2,
      maxPasses: 4,
      passCount: 2,
      activation: "concluded",
      templateVersion: 2,
      authoredContextId: "impl",
    });
  });

  it("renders the logical exit's outgoing edge with the concluding instance as provenance", () => {
    const route = outlineOf(loopExecution()).routes.find(
      (entry) => entry.id === "e2",
    );
    expect(route).toMatchObject({
      source: "verify",
      effectiveSource: "loop-a__p2__verify",
    });
  });

  it("reports no loops for a loop-free execution", () => {
    expect(outlineOf(buildExecution()).loops).toEqual([]);
  });
});

describe("projectLiveOutline — expansion provenance (R13.2)", () => {
  function expandedExecution(): GraphWorkflowExecution {
    return graphWorkflowExecutionSchema.parse({
      ...buildExecution(),
      expansionReceipts: {
        accepted: [
          {
            requestId: "req-1",
            payloadHash: "a".repeat(64),
            invokerContextId: "plan",
            initiatorConversationId: "conv-1",
            rationale: "Fan out three candidates",
            addedContextIds: ["impl"],
            addedTaskIds: ["impl-api"],
            rejoinContextIds: ["verify"],
            liveRevision: 3,
            acceptedAt: "2026-01-01T01:00:00Z",
          },
        ],
        refusals: [
          {
            requestId: "req-2",
            payloadHash: "b".repeat(64),
            invokerContextId: "plan",
            refusalCode: "expansion-context-cap-exceeded",
            refusedAt: "2026-01-01T01:05:00Z",
          },
        ],
      },
    });
  }

  it("reports the acceptance and refusal ledgers", () => {
    const outline = outlineOf(expandedExecution());

    expect(outline.expansions.accepted).toEqual([
      {
        requestId: "req-1",
        invokerContextId: "plan",
        rationale: "Fan out three candidates",
        addedContextIds: ["impl"],
        addedTaskIds: ["impl-api"],
        rejoinContextIds: ["verify"],
        payloadHash: "a".repeat(64),
        acceptedAt: "2026-01-01T01:00:00Z",
      },
    ]);
    expect(outline.expansions.refusals).toEqual([
      {
        requestId: "req-2",
        invokerContextId: "plan",
        refusalCode: "expansion-context-cap-exceeded",
        refusedAt: "2026-01-01T01:05:00Z",
      },
    ]);
  });

  it("names the authorizing request on a runtime-added context row", () => {
    const rows = outlineOf(expandedExecution()).contexts;
    expect(rows.find((row) => row.id === "impl")?.provenance).toEqual({
      requestId: "req-1",
      invokerContextId: "plan",
    });
    expect(rows.find((row) => row.id === "plan")?.provenance).toBeNull();
  });

  it("reports empty ledgers for an execution that never expanded", () => {
    expect(outlineOf(buildExecution()).expansions).toEqual({
      accepted: [],
      refusals: [],
    });
  });
});
