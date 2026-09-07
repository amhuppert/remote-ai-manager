import type { GraphWorkflowExecutionContextState } from "./schemas";

export type ContextActivity =
  | "ordinary_work"
  | "validation"
  | "advisory_response"
  | "merging";

export function classifyContextActivity(
  state: Pick<
    GraphWorkflowExecutionContextState,
    | "status"
    | "mergeStatus"
    | "advisoryResponse"
    | "totalTaskCount"
    | "completedTaskCount"
  >,
): ContextActivity {
  if (state.mergeStatus === "in-progress") return "merging";
  if (state.status !== "running") return "ordinary_work";
  // Advisory response follows certification, so completed task counts cannot
  // classify that turn as another review. Recertifying falls through: the
  // response changed the candidate and a blocking round runs next.
  if (state.advisoryResponse?.phase === "awaiting_response")
    return "advisory_response";
  if (
    state.totalTaskCount > 0 &&
    state.completedTaskCount >= state.totalTaskCount
  )
    return "validation";
  return "ordinary_work";
}
