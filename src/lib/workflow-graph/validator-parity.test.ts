import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createValidatorRunner,
  parseValidatorResponse,
  type ValidatorOutcome,
} from "./validator-runner";
import type {
  ExecuteWorkflowTaskRunInput,
  TaskRunResult,
  TaskRunUsage,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type {
  AgentCallRequest,
  AgentCallResult,
} from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  seedAssignment,
} from "./test-fixtures";

const VALIDATOR_ENGINE = "claude" as const;

// The validator-runner's allowed-task-id check is scoped to the active
// context's tasks. `context-plan` is seeded with task-plan-1 and task-plan-2
// by buildExecution(); these are the IDs the live runner will pass into
// parseValidatorResponse, so the legacy harness uses the same set to keep the
// two paths comparing the exact same parser inputs.
const allowedTaskIds = ["task-plan-1", "task-plan-2"];

const emptyTaskRunUsage: TaskRunUsage = {
  costUsd: null,
  durationMs: null,
  contextTokens: null,
  contextWindowMax: null,
  inputTokens: null,
  outputTokens: null,
  cachedInputTokens: null,
};

const emptyAgentCallUsage = {};

const validatorConfig: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin" as const, id: "general-reviewer" },
  strategy: "conversation" as const,
  authority: "blocking",
  agent: {
    backend: "claude",
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
  },
  continuity: { enabled: false },
};

/**
 * Inline restoration of the legacy `agentCallResultToTaskResult` adapter that
 * previously lived inside validator-runner.ts (between the `executeAgentCall`
 * boundary and `parseValidatorResponse`). Kept verbatim here — not exported
 * from production code — so the parity test exercises the real legacy
 * boundary against the same fixture inputs the new path consumes.
 */
interface LegacyValidatorTaskResult {
  text: string | null;
  structuredOutput?: unknown;
  error: string | null;
  timedOut: boolean;
}

function agentCallResultToLegacyTaskResult(
  result: AgentCallResult,
): LegacyValidatorTaskResult {
  if (result.outcome.kind === "completed") {
    const completed: LegacyValidatorTaskResult = {
      text: result.outcome.text,
      error: null,
      timedOut: false,
    };
    if (result.outcome.structuredOutput !== undefined) {
      completed.structuredOutput = result.outcome.structuredOutput;
    }
    return completed;
  }
  if (result.outcome.kind === "failed") {
    return {
      text: null,
      error: result.outcome.error.message,
      timedOut: result.outcome.error.failureKind === "timeout",
    };
  }
  return {
    text: null,
    error: `validator paused unexpectedly (pauseKind=${result.outcome.pauseKind})`,
    timedOut: false,
  };
}

/**
 * Legacy dispatch loop, reduced to the parser-relevant slice. Mirrors the
 * pre-migration validator-runner: stub `executeAgentCall`, run the result
 * through the legacy adapter, then through `parseValidatorResponse` exactly
 * the way the legacy runner did (including the runner-error short-circuit).
 */
async function runLegacyValidatorPath(
  stubExecuteAgentCall: (request: AgentCallRequest) => Promise<AgentCallResult>,
): Promise<ValidatorOutcome> {
  const request: AgentCallRequest = {
    executionClass: "governed-execution" as const,
    kind: "task_run",
    backend: VALIDATOR_ENGINE,
    prompt: "validator prompt (parity fixture)",
    writeCapability: "write_capable",
    outputSchema: { type: "object" } as Record<string, unknown>,
    laneRef: { workflowId: "exec-parity", laneId: "context_validator" },
  };

  const result = await stubExecuteAgentCall(request);
  const taskResult = agentCallResultToLegacyTaskResult(result);

  if (taskResult.error) {
    return {
      kind: "infra_error",
      reason: "exception",
      message: taskResult.error,
      engine: VALIDATOR_ENGINE,
    };
  }

  return parseValidatorResponse({
    text: taskResult.text ?? "",
    engine: VALIDATOR_ENGINE,
    authority: "blocking",
    structuredOutput: taskResult.structuredOutput,
    allowedTaskIds,
  }).result;
}

function buildExecutionForNewPath(): {
  execution: GraphWorkflowExecution;
  contextDef: GraphWorkflowResolvedContext;
} {
  const definition = createResolvedWorkflowDefinition({
    executionContexts: createResolvedWorkflowDefinition().executionContexts.map(
      (ctx) =>
        ctx.id === "context-plan"
          ? {
              ...ctx,
              acceptanceCriteria:
                "Every task summary is complete and the plan doc is updated.",
              contextValidator: {
                enabled: true,
                assignments: [seedAssignment(validatorConfig)],
              },
            }
          : ctx,
    ),
    tasks: [
      {
        id: "task-plan-1",
        contextId: "context-plan",
        order: 1,
        title: "Inspect code",
        instructions: "Read the relevant files.",
        source: "user",
      },
      {
        id: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        title: "Write plan",
        instructions: "Document the implementation plan.",
        source: "user",
      },
      ...createResolvedWorkflowDefinition().tasks.filter(
        (task) => task.contextId !== "context-plan",
      ),
    ],
  });

  const execution = createWorkflowExecution({
    status: "running",
    activeContextIds: ["context-plan"],
    workingDefinition: definition,
    contextStates: {
      ...createWorkflowExecution().contextStates,
      "context-plan": {
        ...createWorkflowExecution().contextStates["context-plan"]!,
        totalTaskCount: 2,
        completedTaskCount: 2,
      },
    },
    taskStates: {
      ...createWorkflowExecution().taskStates,
      "task-plan-1": {
        ...createWorkflowExecution().taskStates["task-plan-1"]!,
        status: "completed",
        summary: "Inspected the codebase.",
      },
      "task-plan-2": {
        taskId: "task-plan-2",
        contextId: "context-plan",
        order: 2,
        status: "completed",
        summary: "Drafted the implementation plan.",
        startedAt: "2026-03-27T16:05:00.000Z",
        completedAt: "2026-03-27T16:10:00.000Z",
        lastConversationId: "conversation-seed",
        failureMessage: null,
        failureHistory: [],
      },
    },
  });

  const contextDef = definition.executionContexts.find(
    (c) => c.id === "context-plan",
  )!;
  return { execution, contextDef };
}

// A real directory: the new path composes its lane write envelope before
// dispatch, and that composition canonicalizes the candidate worktree and fails
// closed when it cannot resolve.
const stubWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-validator-wt-"));

async function runNewValidatorPath(
  taskRunResult: TaskRunResult,
): Promise<ValidatorOutcome> {
  const executeWorkflowTaskRun = vi.fn(
    async (_input: ExecuteWorkflowTaskRunInput) => taskRunResult,
  );
  const runner = createValidatorRunner({
    resolveWorktreePath: async () => stubWorktreeDir,
    resolveTimeoutMs: async () => 300_000,
    executeWorkflowTaskRun,
    getProjectDisplayName: () => "test-project",
  });

  const { execution, contextDef } = buildExecutionForNewPath();
  const { result } = await runner.runContextValidator({
    projectPath: "/repo",
    sessionName: "session-1",
    execution,
    context: contextDef,
    validator: contextDef.contextValidator.assignments[0]!,
  });
  return result;
}

function completedAgentCallResult(
  text: string | null,
  structuredOutput?: unknown,
): AgentCallResult {
  const completed: AgentCallResult["outcome"] =
    structuredOutput !== undefined
      ? { kind: "completed", text, structuredOutput }
      : { kind: "completed", text };
  return {
    backend: VALIDATOR_ENGINE,
    backendRef: null,
    capabilities: capabilityViewForBackend(VALIDATOR_ENGINE),
    usage: emptyAgentCallUsage,
    artifacts: [],
    outcome: completed,
  };
}

const passPayload = {
  summary: "All tasks satisfy the acceptance criteria.",
  issues: [],
  advisories: [],
};

const failPayload = {
  summary: "Missing documentation in task-plan-2.",
  issues: [
    {
      taskId: "task-plan-2",
      // The seat under test is the acceptance seat, whose every issue must
      // cite a criterion; this context's criteria are prose, so `ac-1` — the
      // deterministic wrap id — is the only citable id.
      criterionId: "ac-1",
      title: "Plan doc missing rollout section",
      description: "Add the rollout section to plan.md.",
    },
  ],
  advisories: [],
};

const mismatchPayload = {
  summary: "Coverage gap.",
  issues: [
    {
      taskId: "task-from-other-context",
      // Cited so the refusal below is about task containment alone: the
      // criterion-citation requirement is checked BEFORE task containment, so
      // an uncited foreign-task issue would be refused for the wrong reason.
      criterionId: "ac-1",
      title: "Wrong context",
      description: "References a task outside the active context.",
    },
  ],
  advisories: [],
};

const fencedJsonText = (payload: unknown): string =>
  ["Here is my review:", "```json", JSON.stringify(payload), "```"].join("\n");

/**
 * The parity test guards the boundary contract between the migrated
 * `executeWorkflowTaskRun` dispatch path and the original `executeAgentCall`
 * dispatch path. Each fixture defines a single model output and feeds it
 * through both paths — the legacy path stubs at the `executeAgentCall`
 * boundary and runs the original adapter inline, the new path stubs at the
 * `executeWorkflowTaskRun` boundary and runs through `createValidatorRunner`.
 * Both paths converge on `parseValidatorResponse` and the resulting
 * `ValidatorOutcome` is asserted deep-equal.
 *
 * If the new adapter ever drops, rewrites, or reorders the parser inputs the
 * legacy boundary produced, this test fails before any production validator
 * turn surfaces the divergence.
 */
describe("validator parity: executeAgentCall (legacy) vs executeWorkflowTaskRun (new)", () => {
  it("native SDK structured output produces identical pass outcomes on both paths", async () => {
    const legacy = await runLegacyValidatorPath(async () =>
      completedAgentCallResult(null, passPayload),
    );
    const next = await runNewValidatorPath({
      kind: "structured",
      structuredOutput: passPayload,
      text: "",
      usage: emptyTaskRunUsage,
      backendRef: null,
      continuationDisposition: "retain",
    });

    expect(next).toEqual(legacy);
    expect(next.kind).toBe("pass");
    if (next.kind === "pass") {
      expect(next.summary).toBe(passPayload.summary);
      expect(next.issues).toEqual([]);
      expect(next.reopenTaskIds).toEqual([]);
    }
  });

  it("raw JSON in text body produces identical fail outcomes on both paths", async () => {
    const rawJson = JSON.stringify(failPayload);
    const legacy = await runLegacyValidatorPath(async () =>
      completedAgentCallResult(rawJson),
    );
    const next = await runNewValidatorPath({
      kind: "text",
      text: rawJson,
      usage: emptyTaskRunUsage,
      backendRef: null,
      continuationDisposition: "retain",
    });

    expect(next).toEqual(legacy);
    expect(next.kind).toBe("fail");
    if (next.kind === "fail") {
      expect(next.summary).toBe(failPayload.summary);
      expect(next.issues).toEqual(failPayload.issues);
      expect(next.reopenTaskIds).toEqual(["task-plan-2"]);
    }
  });

  it("fenced ```json block produces identical pass outcomes on both paths", async () => {
    const text = fencedJsonText(passPayload);
    const legacy = await runLegacyValidatorPath(async () =>
      completedAgentCallResult(text),
    );
    const next = await runNewValidatorPath({
      kind: "text",
      text,
      usage: emptyTaskRunUsage,
      backendRef: null,
      continuationDisposition: "retain",
    });

    expect(next).toEqual(legacy);
    expect(next.kind).toBe("pass");
    if (next.kind === "pass") {
      expect(next.summary).toBe(passPayload.summary);
    }
  });

  it("malformed output produces identical infra_error unparseable outcomes on both paths", async () => {
    const text = "I could not produce structured output.";
    const legacy = await runLegacyValidatorPath(async () =>
      completedAgentCallResult(text),
    );
    const next = await runNewValidatorPath({
      kind: "text",
      text,
      usage: emptyTaskRunUsage,
      backendRef: null,
      continuationDisposition: "retain",
    });

    expect(next).toEqual(legacy);
    expect(next.kind).toBe("infra_error");
    if (next.kind === "infra_error") {
      expect(next.reason).toBe("unparseable");
      expect(next.engine).toBe(VALIDATOR_ENGINE);
    }
  });

  it("allowed-task-id mismatch produces identical schema_mismatch infra_error on both paths", async () => {
    const legacy = await runLegacyValidatorPath(async () =>
      completedAgentCallResult(null, mismatchPayload),
    );
    const next = await runNewValidatorPath({
      kind: "structured",
      structuredOutput: mismatchPayload,
      text: "",
      usage: emptyTaskRunUsage,
      backendRef: null,
      continuationDisposition: "retain",
    });

    expect(next).toEqual(legacy);
    expect(next.kind).toBe("infra_error");
    if (next.kind === "infra_error") {
      expect(next.reason).toBe("schema_mismatch");
      expect(next.engine).toBe(VALIDATOR_ENGINE);
      expect(next.message).toContain("task-from-other-context");
    }
  });
});
