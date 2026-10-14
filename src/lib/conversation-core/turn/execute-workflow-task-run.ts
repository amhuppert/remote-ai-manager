import { type TaskTurnRequest, type ConversationBinding } from "./turn-spec";
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
