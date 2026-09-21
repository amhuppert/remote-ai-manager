import { createTestGraphExecutionContract } from "@/lib/workflow-graph/testing/execution-contract";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type {
  ConversationBackendRuntime,
  ConversationBackendTurnInput,
} from "@/lib/agent-backends/conversation";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  createValidatorRunner,
  parseValidatorResponse,
} from "./validator-runner";
import { createValidatorConversationHarness } from "./testing/validator-conversation-harness";
import type { GraphWorkflowExecution } from "./schemas";
import type { ValidatorAssignment } from "./config-schemas";
import type { GraphWorkflowResolvedContext } from "./definition-schemas";
import {
  createResolvedWorkflowDefinition,
  createWorkflowExecution,
  seedAssignment,
  makeStubValidatorContinuityService,
} from "./test-fixtures";

const VALIDATOR_ENGINE = "claude" as const;
const allowedTaskIds = ["task-plan-1", "task-plan-2"];
const validatorConfig: ValidatorAssignment = {
  id: "general",
  profile: { tier: "builtin", id: "general-reviewer" },
  authority: "blocking",
  agent: {
    backend: VALIDATOR_ENGINE,
    modelSelection: { modelId: "sonnet", parameters: { effort: "medium" } },
  },
};

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

// The write envelope canonicalizes the candidate directory before dispatch.
const stubWorktreeDir = mkdtempSync(path.join(tmpdir(), "cc-validator-wt-"));

interface ProviderOutput {
  text: string | null;
  structuredOutput?: unknown;
}

function refusalIssues(result: AgentCallResult): string[] {
  if (result.outcome.kind !== "failed")
    throw new Error("Expected facade schema refusal");
  return z
    .object({ errors: z.array(z.string()).min(1) })
    .parse(result.outcome.error.backendDetails).errors;
}

/** Production actor, facade, and validator parser; only the backend is scripted. */
async function runValidatorPath(providerOutput: ProviderOutput) {
  const turns: ConversationBackendTurnInput[] = [];
  const runtime: ConversationBackendRuntime = {
    backend: VALIDATOR_ENGINE,
    status: "alive",
    modelSelection: validatorConfig.agent.modelSelection,
    async sendTurn(input) {
      turns.push(input);
      const output: ProviderOutput = input.outputFormat
        ? providerOutput
        : {
            text: "Reviewed the completed tasks against the acceptance criteria.",
          };
      return {
        backendRef: {
          backend: VALIDATOR_ENGINE,
          ref: "validator-parity-thread",
        },
        costUsd: null,
        durationMs: 1,
        numTurns: 1,
        contextTokens: null,
        contextWindowMax: null,
        contentBlocks:
          output.text === null ? [] : [{ type: "text", text: output.text }],
        structuredOutput: output.structuredOutput,
        aborted: false,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
      };
    },
    async close() {},
  };
  const { execution, contextDef } = buildExecutionForNewPath();
  const validator = contextDef.contextValidator.assignments[0];
  if (!validator) throw new Error("Missing validator fixture assignment");
  const harness = createValidatorConversationHarness({
    backendFactory: {
      backend: VALIDATOR_ENGINE,
      validateModelSelection() {},
      async createRuntime() {
        return runtime;
      },
    },
    execution,
    context: contextDef,
    validator,
    worktreePath: stubWorktreeDir,
  });
  const facadeResults: AgentCallResult[] = [];
  const runner = createValidatorRunner({
    continuityService: makeStubValidatorContinuityService(),
    executionContract: createTestGraphExecutionContract(),
    resolveWorktreePath: async () => stubWorktreeDir,
    ...harness,
    async executeConversationTurn(input) {
      const result = await harness.executeConversationTurn(input);
      if (
        result.kind === "settled" &&
        result.turn.outcome.kind === "call_result"
      )
        facadeResults.push(result.turn.outcome.result);
      return result;
    },
    getProjectDisplayName: () => "test-project",
  });
  const { result } = await runner.runContextValidator({
    projectPath: "/repo",
    sessionName: "session-1",
    execution,
    context: contextDef,
    validator,
  });
  const facadeResult = facadeResults.at(-1);
  if (!facadeResult)
    throw new Error("Validator did not return a facade result");
  return { result, facadeResult, turns };
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

describe("validator parity across facade extraction sources", () => {
  describe.each(["native", "raw_json", "fenced"] as const)("%s", (source) => {
    function providerOutput(payload: unknown): ProviderOutput {
      if (source === "native") return { text: null, structuredOutput: payload };
      return {
        text:
          source === "raw_json"
            ? JSON.stringify(payload)
            : fencedJsonText(payload),
      };
    }

    it.each([
      { label: "pass", payload: passPayload, reopenTaskIds: [] },
      { label: "fail", payload: failPayload, reopenTaskIds: ["task-plan-2"] },
    ])(
      "preserves the $label verdict through the production conversation path",
      async ({ label, payload, reopenTaskIds }) => {
        const { result, facadeResult, turns } = await runValidatorPath(
          providerOutput(payload),
        );
        const parsed = parseValidatorResponse({
          structuredOutput: payload,
          engine: VALIDATOR_ENGINE,
          authority: "blocking",
          allowedTaskIds,
        }).result;

        expect(result).toEqual(parsed);
        expect(result).toMatchObject({
          kind: label,
          summary: payload.summary,
          issues: payload.issues,
          reopenTaskIds,
        });
        expect(facadeResult.outcome).toMatchObject({
          kind: "completed",
          structuredOutput: payload,
          parse: { source },
        });
        expect(turns).toHaveLength(2);
        expect(turns[0]?.outputFormat).toBeUndefined();
        expect(turns[1]?.outputFormat?.type).toBe("json_schema");
      },
    );
  });

  it("refuses malformed output only after the facade's bounded format repair", async () => {
    const { result, facadeResult, turns } = await runValidatorPath({
      text: "I could not produce structured output.",
    });

    expect(result).toMatchObject({
      kind: "infra_error",
      engine: VALIDATOR_ENGINE,
      failure: { kind: "schema_validation" },
      structuredOutputRepair: { attempts: 1, maxAttempts: 1 },
    });
    expect(facadeResult.outcome).toMatchObject({
      kind: "failed",
      error: {
        failureKind: "schema_validation",
        backendDetails: { repairAttempts: 1, repairMaxAttempts: 1 },
      },
    });
    expect(turns).toHaveLength(3);
    expect(turns[0]?.outputFormat).toBeUndefined();
    expect(turns[2]?.outputFormat).toEqual(turns[1]?.outputFormat);
    const issues = refusalIssues(facadeResult);
    expect(result).toMatchObject({ structuredOutputIssues: issues });
    expect(turns[2]?.promptText).toContain(issues[0]);
  });

  it("rejects a foreign task id at the facade gate and retains the named issue", async () => {
    const { result, facadeResult, turns } = await runValidatorPath({
      text: null,
      structuredOutput: mismatchPayload,
    });

    expect(result).toMatchObject({
      kind: "infra_error",
      engine: VALIDATOR_ENGINE,
      failure: { kind: "schema_validation" },
      structuredOutputRepair: { attempts: 1, maxAttempts: 1 },
    });
    expect(facadeResult.outcome.kind).toBe("failed");
    expect(turns).toHaveLength(3);
    const issues = refusalIssues(facadeResult);
    expect(result).toMatchObject({ structuredOutputIssues: issues });
    expect(issues.join("\n")).toContain("taskId");
    expect(turns[2]?.promptText).toContain("taskId");
  });
});
