import type { TaskRunResult } from "./turn-result";
import {
  taskTurnRequestSchema,
  type TaskTurnRequest,
  type ConversationBinding,
} from "./turn-spec";
import { toTaskRunResult } from "./turn-result";
import { executeConversationTurn } from "./manager";
/**
 * Named entrypoint workflow callers use to drive a single `task_run` turn
 * through the conversation actor.
 *
 * Accepts an explicit conversation binding and awaits the lifecycle's admitted
 * attempt. The lifecycle serializes admission, cancellation, and cleanup. The
 * shared result retains task output and failure metadata for workflow policy.
 *
 * The entrypoint NEVER calls `executeAgentCall` directly — every turn is
 * routed through the actor and the existing `runTaskRun` actor implementation.
 */

import { createLogger, type Logger } from "@/lib/logging";
import { conversationTargetLogFields } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation.execute-workflow-task-run");

export interface ExecuteWorkflowTaskRunInput extends Omit<
  TaskTurnRequest,
  "promptText" | "backend"
> {
  binding: ConversationBinding;
  kind: "task_run";
  prompt: string;
  /** Cancels the admitted attempt and waits for its execution and cleanup. */
  signal?: AbortSignal;
}

/**
 * Diagnostic sinks for one task run. Injectable because log FIELDS are a public
 * identity surface (R1.3): project compaction and ticket generation address this
 * entrypoint with the project store key, and a test can only prove the emitted
 * identity is scope-discriminated if the sink is a dependency.
 */
export interface ExecuteWorkflowTaskRunDeps {
  log?: Logger;
}

export function createWorkflowTaskRunExecutor(
  lifecycle: Pick<
    import("./manager").ConversationManager,
    "executeConversationTurn"
  >,
) {
  return async function executeWorkflowTaskRun(
    input: ExecuteWorkflowTaskRunInput,
    deps: ExecuteWorkflowTaskRunDeps = {},
  ): Promise<TaskRunResult> {
    const log = deps.log ?? logger;
    const identity = conversationTargetLogFields(input.binding.address.target);
    log.info("conversation.execute_workflow_task_run.dispatch", {
      ...identity,
      kind: input.kind,
      hasOutputFormat: input.outputFormat !== undefined,
      hasSystemInstructions: input.systemInstructions !== undefined,
      hasTooling: input.tooling !== undefined,
      // Whether the turn carries a write envelope at all: the difference between
      // a restricted lane and an unrestricted one is invisible in every other
      // field on this event.
      hasFsWritePolicy: input.fsWritePolicy !== undefined,
      timeoutMs: input.timeoutMs ?? null,
    });
    const execution = await lifecycle.executeConversationTurn({
      binding: input.binding,
      turn: taskTurnRequestSchema
        .strip()
        .parse({ ...input, promptText: input.prompt }),
      signal: input.signal,
      waitUntilReady: true,
    });
    const result = toTaskRunResult(
      execution.kind === "settled"
        ? execution.turn.outcome
        : {
            kind: "not_started",
            reason:
              execution.code === "cancelled" ? "cancelled" : "configuration",
            message: execution.message,
          },
      input.outputFormat,
      { structuredOutputTextField: input.structuredOutputTextField },
    );
    log.info("conversation.execute_workflow_task_run.finalized", {
      ...identity,
      kind: input.kind,
      hadError: result.kind === "error",
      aborted: result.kind === "error" && result.aborted,
    });
    return result;
  };
}

const productionTaskRun = createWorkflowTaskRunExecutor({
  executeConversationTurn,
});
export function executeWorkflowTaskRun(
  input: ExecuteWorkflowTaskRunInput,
  deps: ExecuteWorkflowTaskRunDeps = {},
): Promise<TaskRunResult> {
  return productionTaskRun(input, deps);
}
