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
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      contextValidator: {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      scriptValidator: { enabled: false },
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
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      },
      contextValidator: {
        type: "claude",
        enabled: true,
        continuity: { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      scriptValidator: { enabled: true },
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
      implementer: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      contextValidator: null,
      scriptValidator: { enabled: false },
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
      validator: { type: "claude", model: "sonnet", reasoningEffort: "medium" },
      scriptValidator: false,
      humanApprovalGate: false,
      askUserQuestions: false,
    });
    expect(byId["impl"]).toMatchObject({
      scriptValidator: true,
      humanApprovalGate: true,
    });
    // verify: codex implementer, validator off.
    expect(byId["verify"]).toMatchObject({
      implementer: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      validator: null,
    });
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
    expect(result.context.config.scriptValidator).toEqual({ enabled: true });
    expect(result.context.config.humanApprovalGate).toEqual({ enabled: true });
    expect(result.context.config.iterationPolicy.maxIterations).toBe(20);
    expect(result.context.config.circuitBreaker).toBeDefined();
    expect(result.context.config.mutability).toEqual({
      allowAgentTaskAdd: false,
    });
    expect(result.context.config.contextValidator).toMatchObject({
      type: "claude",
      enabled: true,
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
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      contextValidator: null,
      scriptValidator: { enabled: false },
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
