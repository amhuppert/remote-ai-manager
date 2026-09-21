/**
 * One-shot repair-agent dispatch (docs/design/cc-cli/08 §The repair agent).
 * Follows the context-validator's transient-lane pattern: an ephemeral,
 * session-scoped conversation actor pinned to the session worktree (the
 * execution is quiescent, so no lane turn can race it), a `task_run` turn with
 * the verdict JSON schema enforced at the structured-output gate, and robust
 * candidate extraction for backends that only return text.
 *
 * The turn runs under the session-reader write envelope — its own scratch and
 * temp only, with repository metadata denied — for EVERY run, not only a run
 * pinned read-only by the dirty-worktree exemption (D7 decision D10). A repair
 * agent changes the plan through live-edit operations it returns; it has no
 * reason to touch the worktree at all. The backend applies the policy through
 * native confinement or instruction-only limits according to its descriptor.
 * An envelope that cannot be composed ends the attempt before dispatch.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  composeImplementerLaneWriteEnvelope,
  type ImplementerLaneWriteEnvelope,
} from "@/lib/workflow-graph/implementer-lane-write-envelope";
import {
  executeWorkflowTaskRun as defaultExecuteWorkflowTaskRun,
  type ExecuteWorkflowTaskRunInput,
} from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { ConversationBinding } from "@/lib/workflows/conversation/turn-spec";
import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
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
  composeWriteEnvelope?: typeof composeImplementerLaneWriteEnvelope;
}

function buildRepairBinding(
  invocation: PlanRepairAgentInvocation,
  projectName: string,
): ConversationBinding {
  return {
    // A synthetic repair lane has no persisted ConversationState record, so it
    // runs the ephemeral persistence adapter (validator-runner precedent).
    kind: "ephemeral",
    address: {
      projectPath: invocation.projectPath,
      target: sessionConversationTarget(
        projectName,
        invocation.sessionName,
        invocation.conversationId,
      ),
    },
    worktreePath: invocation.worktreePath,
    backend: invocation.agent.backend,
    role: null,
    transcriptPath: null,
  };
}

export function createPlanRepairAgentRunner(
  deps: PlanRepairAgentRunnerDeps = {},
) {
  const executeWorkflowTaskRun =
    deps.executeWorkflowTaskRun ?? defaultExecuteWorkflowTaskRun;
  const getProjectDisplayName =
    deps.getProjectDisplayName ?? defaultGetProjectDisplayName;
  const composeWriteEnvelope =
    deps.composeWriteEnvelope ?? composeImplementerLaneWriteEnvelope;

  return async function runRepairAgent(
    invocation: PlanRepairAgentInvocation,
  ): Promise<PlanRepairAgentResult> {
    const projectName = getProjectDisplayName(invocation.projectPath);

    // Read-only by construction: no owned prefix, and payloads land in the
    // agent's private scratch so the turn creates nothing in the repository.
    let writeEnvelope: ImplementerLaneWriteEnvelope;
    try {
      writeEnvelope = composeWriteEnvelope({
        executionId: invocation.executionId,
        contextId: invocation.contextId,
        worktreePath: invocation.worktreePath,
        ownedPaths: [],
        payloadLocation: "scratch",
      });
    } catch (error) {
      const message = `Cannot establish the plan-repair write envelope: ${getErrorMessage(error)}`;
      logger.error("plan_repair.write_envelope_failed", {
        executionId: invocation.executionId,
        contextId: invocation.contextId,
        worktreePath: invocation.worktreePath,
        error: getErrorMessage(error),
      });
      return {
        kind: "error",
        message,
        conversationId: invocation.conversationId,
      };
    }

    const result = await executeWorkflowTaskRun({
      fsWritePolicy: writeEnvelope.policy,
      kind: "task_run",
      executionClass: "governed-execution",
      executionProfile: "standard",
      prompt: invocation.prompt,
      structuredOutputTurns: "work_then_format",
      outputFormat: {
        type: "json_schema",
        schema: PLAN_REPAIR_VERDICT_JSON_SCHEMA,
      },
      timeoutMs: invocation.timeoutMs,
      modelSelection: invocation.agent.modelSelection,
      binding: buildRepairBinding(invocation, projectName),
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

    const validated = planRepairAgentOutputSchema.safeParse(
      result.kind === "structured" ? result.structuredOutput : undefined,
    );
    if (!validated.success) {
      logger.warn("plan_repair.verdict_unparseable", {
        executionId: invocation.executionId,
        contextId: invocation.contextId,
        stage: "schema",
        error: validated.error.message,
      });
      return {
        kind: "error",
        message: `repair verdict did not validate: ${validated.error.message}`,
        conversationId: invocation.conversationId,
      };
    }

    const decoded = decodePlanRepairAgentOutput(validated.data);
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
