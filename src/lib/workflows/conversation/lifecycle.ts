import {
  createConversationManager,
  type ConversationManager,
  type ActiveConversationTurnDescription,
  type ConversationCommandOutcome,
  type IdleRuntimeRelease,
  type ConversationTurnExecution,
  type ConversationCheckpointCheck,
  type ConversationCheckpointRequest,
  type ConversationCheckpointStart,
  type ConversationCheckpointReconcile,
  type ConversationCheckpointCancel,
} from "./manager";
import { createProductionConversationManagerDependencies } from "./production";
import type {
  ConversationAddress,
  ConversationBinding,
  ConversationTurnSubmission,
  TurnAdmission,
  TurnCancelReason,
} from "./turn-spec";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import type { DesiredRuntimeConfiguration } from "./pre-turn/runtime-recreate";
import {
  createWorkflowTaskRunExecutor,
  type ExecuteWorkflowTaskRunInput,
  type ExecuteWorkflowTaskRunDeps,
} from "./execute-workflow-task-run";
import type { TaskRunResult } from "./turn-result";

type ConversationQuestionBatch = Parameters<
  ConversationManager["registerConversationQuestion"]
>[3];

let productionManager: ConversationManager | undefined;
function defaultManager(): ConversationManager {
  return (productionManager ??= createConversationManager(
    createProductionConversationManagerDependencies(),
  ));
}

export function describeActiveTurn(
  address: ConversationAddress,
): ActiveConversationTurnDescription | null {
  return defaultManager().describeActiveTurn(address);
}

export function checkpointAcceptsQueuedInput(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): boolean {
  return defaultManager().checkpointAcceptsQueuedInput(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function getConversationTooling(
  address: ConversationAddress,
):
  | Readonly<import("@/lib/agent-backends/types").ConversationToolingOverrides>
  | undefined {
  return defaultManager().getConversationTooling(address);
}

export function executeConversationCommand(
  address: ConversationAddress,
  command: DebugCommand,
): Promise<ConversationCommandOutcome> {
  return defaultManager().executeConversationCommand(address, command);
}

export function releaseIdleConversationRuntime(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<IdleRuntimeRelease> {
  return defaultManager().releaseIdleConversationRuntime(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function ensureConversationLifecycle(
  binding: ConversationBinding,
): Promise<void> {
  return defaultManager().ensureConversationLifecycle(binding);
}

export function submitConversationTurn(
  input: ConversationTurnSubmission,
): Promise<TurnAdmission> {
  return defaultManager().submitConversationTurn(input);
}

export function retryConversationTurn(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<boolean> {
  return defaultManager().retryConversationTurn(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function executeConversationTurn(
  input: ConversationTurnSubmission,
): Promise<ConversationTurnExecution> {
  return defaultManager().executeConversationTurn(input);
}

export function ensureConversationActorAndDrain(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  return defaultManager().ensureConversationActorAndDrain(
    projectPath,
    sessionName,
    conversationId,
  );
}

export function registerConversationQuestion(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  question: ConversationQuestionBatch,
): Promise<boolean> {
  return defaultManager().registerConversationQuestion(
    projectPath,
    sessionName,
    conversationId,
    question,
  );
}

export function clearConversationQuestion(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  question: { questionId: string },
): Promise<boolean> {
  return defaultManager().clearConversationQuestion(
    projectPath,
    sessionName,
    conversationId,
    question,
  );
}

export function requestConversationStop(
  address: ConversationAddress,
  reason: TurnCancelReason,
): { requested: boolean; settled: Promise<void> } {
  return defaultManager().requestConversationStop(address, reason);
}

export function stopConversationActor(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  reason: string,
): Promise<void> {
  return defaultManager().stopConversationActor(
    projectPath,
    sessionName,
    conversationId,
    reason,
  );
}

export function restorePersistedConversations(): Promise<number> {
  return defaultManager().restorePersistedConversations();
}

export function stopAllConversationActors(): Promise<void> {
  return defaultManager().stopAllConversationActors();
}

export function getConversationRuntimeConfiguration(
  conversationId: string,
):
  | Readonly<import("./pre-turn/runtime-recreate").RecreateRuntimeSnapshot>
  | undefined {
  return defaultManager().getConversationRuntimeConfiguration(conversationId);
}

export function readDesiredConversationRuntimeConfiguration(
  conversationId: string,
  current: DesiredRuntimeConfiguration,
): Promise<DesiredRuntimeConfiguration> {
  return defaultManager().readDesiredConversationRuntimeConfiguration(
    conversationId,
    current,
  );
}

export function checkConversationCheckpoint(
  address: ConversationAddress,
  options?: { recover?: string | null },
): Promise<ConversationCheckpointCheck> {
  return defaultManager().checkConversationCheckpoint(address, options);
}

export function startConversationCheckpoint(
  input: ConversationCheckpointRequest,
): Promise<ConversationCheckpointStart> {
  return defaultManager().startConversationCheckpoint(input);
}

export function reconcileConversationCheckpoint(input: {
  address: ConversationAddress;
  operationId: string;
  captureExecutionStopped?: boolean;
  source?: "cli" | "ui" | "api";
}): Promise<ConversationCheckpointReconcile> {
  return defaultManager().reconcileConversationCheckpoint(input);
}

export function cancelConversationCheckpoint(input: {
  address: ConversationAddress;
  operationId: string;
}): Promise<ConversationCheckpointCancel> {
  return defaultManager().cancelConversationCheckpoint(input);
}

export function skipConversationCheckpointHandoff(input: {
  address: ConversationAddress;
  operationId: string;
}) {
  return defaultManager().skipConversationCheckpointHandoff(input);
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
