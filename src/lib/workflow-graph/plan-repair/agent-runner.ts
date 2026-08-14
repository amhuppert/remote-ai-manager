/**
 * One-shot repair-agent dispatch (docs/design/cc-cli/08 §The repair agent).
 * Follows the context-validator's transient-lane pattern: an ephemeral,
 * session-scoped conversation actor pinned to the session worktree (the
 * execution is quiescent, so no lane turn can race it), a `task_run` turn with
 * the verdict JSON schema enforced at the structured-output gate, and robust
 * candidate extraction for backends that only return text.
 */

import { createLogger } from "@/lib/logging";
import { validateStructuredOutput } from "@/lib/agent-backends/structured-output";
import {
  executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun,
  type ExecuteWorkflowTaskRunInput,
  type TaskRunResult,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { EnsureActorInputData } from "@/lib/workflows/conversation/manager";
import { getProjectDisplayName as defaultGetProjectDisplayName } from "@/lib/projects/resolver";
import {
  decodePlanRepairAgentOutput,
  PLAN_REPAIR_VERDICT_JSON_SCHEMA,
  planRepairAgentOutputSchema,
} from "./schemas";
import type {
  PlanRepairAgentInvocation,
  PlanRepairAgentResult,
} from "./supervisor";

const logger = createLogger("workflow.plan-repair");

export interface PlanRepairAgentRunnerDeps {
  executeWorkflowTaskRun?(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
  getProjectDisplayName?(projectPath: string): string;
}

function buildRepairActorInput(
  invocation: PlanRepairAgentInvocation,
  projectName: string,
): EnsureActorInputData {
  return {
    conversationScope: "session",
    projectName,
    sessionWorktreePath: invocation.worktreePath,
    // A synthetic repair lane has no persisted ConversationState record, so it
    // runs the ephemeral persistence adapter (validator-runner precedent).
    persistence: "ephemeral",
    conversation: {
      createdAt: new Date().toISOString(),
      forkedFrom: null,
      role: null,
      transcriptPath: null,
      agentBackend: invocation.agent.backend,
      backendRef: null,
      promptCount: 0,
      debugMode: null,
    },
  };
}

export function createPlanRepairAgentRunner(
  deps: PlanRepairAgentRunnerDeps = {},
) {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  const getProjectDisplayName =
    deps.getProjectDisplayName ?? defaultGetProjectDisplayName;

  return async function runRepairAgent(
    invocation: PlanRepairAgentInvocation,
  ): Promise<PlanRepairAgentResult> {
    const projectName = getProjectDisplayName(invocation.projectPath);
    const result = await executeWorkflowTaskRun({
      projectPath: invocation.projectPath,
      sessionName: invocation.sessionName,
      conversationId: invocation.conversationId,
      kind: "task_run",
      prompt: invocation.prompt,
      outputFormat: {
        type: "json_schema",
        schema: PLAN_REPAIR_VERDICT_JSON_SCHEMA,
      },
      timeoutMs: invocation.timeoutMs,
      modelId: invocation.agent.model,
      effort: invocation.agent.reasoningEffort,
      actorInput: buildRepairActorInput(invocation, projectName),
      origin: {
        source: "workflow",
        workflow: {
          executionId: invocation.executionId,
          nodeId: invocation.contextId,
          iterationIndex: 0,
        },
      },
    });

    if (result.kind === "error") {
      return {
        kind: "error",
        message: result.error,
        conversationId: invocation.conversationId,
      };
    }

    const validated = validateStructuredOutput(planRepairAgentOutputSchema, {
      ...(result.kind === "structured"
        ? { native: result.structuredOutput }
        : {}),
      text: result.text.length > 0 ? result.text : null,
    });
    if (!validated.ok) {
      logger.warn("plan_repair.verdict_unparseable", {
        executionId: invocation.executionId,
        contextId: invocation.contextId,
        stage: validated.stage,
        error: validated.error,
      });
      return {
        kind: "error",
        message: `repair verdict did not validate: ${validated.error}`,
        conversationId: invocation.conversationId,
      };
    }

    const decoded = decodePlanRepairAgentOutput(validated.value);
    if (!decoded.ok) {
      logger.warn("plan_repair.verdict_unparseable", {
        executionId: invocation.executionId,
        contextId: invocation.contextId,
        stage: "operation_payload",
        error: decoded.error,
      });
      return {
        kind: "error",
        message: `repair verdict did not validate: ${decoded.error}`,
        conversationId: invocation.conversationId,
      };
    }

    return {
      kind: "verdict",
      verdict: decoded.verdict,
      conversationId: invocation.conversationId,
    };
  };
}
