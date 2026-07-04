"use client";

import { useCallback, useState } from "react";
import type { ComponentProps } from "react";
import type AskQuestionPanel from "@/components/AskQuestionPanel";
import { useAnswerQuestionMutation } from "@/lib/conversations/mutations";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type {
  GraphWorkflowExecution,
  GraphWorkflowStatus,
} from "@/lib/workflows/schemas";

export type AskQuestionPanelProps = ComponentProps<typeof AskQuestionPanel>;

/**
 * Execution statuses under which a parked user-input question keeps standing —
 * the park survives pause/halt/restart and disappears only when the execution
 * leaves the in-flight set. Mirrors the approval gate's standing derivation
 * (`use-approval-gate.ts`); keep the two in sync.
 */
const PARK_STANDING_EXECUTION_STATUSES: ReadonlySet<GraphWorkflowStatus> =
  new Set(["running", "paused", "halted"]);

export interface UserInputStanding {
  contextId: string;
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
}

/**
 * Standing for one execution context: the execution is in-flight and the
 * context is parked `awaiting_user_input` with an unanswered `pendingUserInput`
 * record. Derived purely from execution state so it survives pause/halt/restart
 * and self-clears once answers are recorded (the record's `answers` is set).
 */
export function deriveUserInputStanding(
  execution: GraphWorkflowExecution | null,
  contextId: string | null,
): UserInputStanding | null {
  if (!execution || contextId === null) return null;
  if (!PARK_STANDING_EXECUTION_STATUSES.has(execution.status)) return null;
  const contextState = execution.contextStates[contextId];
  if (!contextState) return null;
  if (contextState.status !== "awaiting_user_input") return null;
  const record = contextState.pendingUserInput;
  if (!record || record.answers !== null) return null;
  return {
    contextId,
    conversationId: record.conversationId,
    questionBatchId: record.questionBatchId,
    questions: record.questions,
  };
}

export interface UseUserInputGateArgs {
  projectName: string;
  sessionName: string;
  execution: GraphWorkflowExecution | null;
  contextId: string | null;
  /** Asking agent; drives the panel accent color (cyan = claude, violet = codex). */
  agent?: AgentBackendId;
}

/**
 * Builds the AskQuestionPanel props for a parked context selected in the graph
 * inspector, or null when the context has no unanswered parked question. Submit
 * reuses the ordinary answer mutation against the asking conversation; the
 * panel's promise-returning `onSubmit` drives its own visible pending state.
 */
export function useUserInputGate({
  projectName,
  sessionName,
  execution,
  contextId,
  agent,
}: UseUserInputGateArgs): AskQuestionPanelProps | null {
  const standing = deriveUserInputStanding(execution, contextId);
  const [currentIndex, setCurrentIndex] = useState(0);
  // Reset navigation to the first question when the selected context changes so
  // one parked context's index never carries into another's panel. Uses the
  // adjust-state-during-render pattern (not an effect) so the reset lands before
  // the panel renders.
  const [trackedContextId, setTrackedContextId] = useState(contextId);
  if (contextId !== trackedContextId) {
    setTrackedContextId(contextId);
    setCurrentIndex(0);
  }
  const answerMutation = useAnswerQuestionMutation(
    projectName,
    sessionName,
    standing?.conversationId ?? "",
  );

  const onSubmit = useCallback<AskQuestionPanelProps["onSubmit"]>(
    async (questionId, answers) => {
      try {
        await answerMutation.mutateAsync({ questionId, answers });
      } catch {
        // Best effort — the panel stays mounted for retry until the execution
        // refetch clears the standing.
      }
    },
    [answerMutation],
  );

  if (standing === null) return null;

  return {
    questions: standing.questions,
    questionId: standing.questionBatchId,
    currentIndex,
    onNavigate: setCurrentIndex,
    onSubmit,
    ...(agent !== undefined && { agent }),
  };
}
