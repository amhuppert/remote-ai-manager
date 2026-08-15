"use client";

import { useCallback, useState } from "react";
import type { ComponentProps } from "react";
import type AskQuestionPanel from "@/components/AskQuestionPanel";
import { useAnswerQuestionMutation } from "@/lib/conversations/mutations";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import { holdsActionableGate } from "@/lib/workflow-graph/lifecycle-classifier";
import { unansweredPendingUserInputs } from "@/lib/workflow-graph/pending-user-input";

export type AskQuestionPanelProps = ComponentProps<typeof AskQuestionPanel>;

export interface UserInputStanding {
  contextId: string;
  /** Which lane is waiting — `implementer` or `context_validator:<assignmentId>`. */
  laneKey: string;
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
}

/**
 * Every lane of one execution context that is still waiting on the human: the
 * execution is in-flight, the context is parked `awaiting_user_input`, and the
 * lane's record has no answers yet.
 *
 * A LIST because a cohort's validators ask independently — several can be
 * waiting at once, each on its own conversation — and an operator who is only
 * shown the first would have no way to reach the rest. Derived purely from
 * execution state, so it survives pause/halt/restart and each lane self-clears
 * as its answers are recorded.
 */
export function deriveUserInputStandings(
  execution: GraphWorkflowExecution | null,
  contextId: string | null,
): UserInputStanding[] {
  if (!execution || contextId === null) return [];
  // Tenure through the one contract, not a mirrored status set: a park on a run
  // that can never continue is a question nobody can answer.
  if (
    !holdsActionableGate(
      execution.status,
      execution.haltReason,
      execution.abandonment,
    )
  ) {
    return [];
  }
  const contextState = execution.contextStates[contextId];
  if (!contextState) return [];
  if (contextState.status !== "awaiting_user_input") return [];
  return unansweredPendingUserInputs(contextState).map((entry) => ({
    contextId,
    laneKey: entry.laneKey,
    conversationId: entry.record.conversationId,
    questionBatchId: entry.record.questionBatchId,
    questions: entry.record.questions,
  }));
}

export interface UseUserInputGateArgs {
  projectName: string;
  sessionName: string;
  /** The one waiting lane this panel answers. */
  standing: UserInputStanding;
  /** Asking agent; drives the panel accent color (cyan = claude, violet = codex). */
  agent?: AgentBackendId;
}

/**
 * Builds the AskQuestionPanel props for ONE parked lane. Submit reuses the
 * ordinary answer mutation against that lane's asking conversation; the panel's
 * promise-returning `onSubmit` drives its own visible pending state.
 *
 * Scoped to a single lane because the answer mutation is bound to the
 * conversation it answers: a context with two waiting validators renders two
 * panels, each with its own hook instance and its own conversation.
 */
export function useUserInputGate({
  projectName,
  sessionName,
  standing,
  agent,
}: UseUserInputGateArgs): AskQuestionPanelProps {
  const [currentIndex, setCurrentIndex] = useState(0);
  // Reset navigation to the first question when the panel is pointed at another
  // lane's batch, so one lane's index never carries into another's panel. Uses
  // the adjust-state-during-render pattern (not an effect) so the reset lands
  // before the panel renders.
  const [trackedBatchId, setTrackedBatchId] = useState(
    standing.questionBatchId,
  );
  if (standing.questionBatchId !== trackedBatchId) {
    setTrackedBatchId(standing.questionBatchId);
    setCurrentIndex(0);
  }
  const answerMutation = useAnswerQuestionMutation(
    projectName,
    sessionName,
    standing.conversationId,
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

  return {
    questions: standing.questions,
    questionId: standing.questionBatchId,
    currentIndex,
    onNavigate: setCurrentIndex,
    onSubmit,
    ...(agent !== undefined && { agent }),
  };
}
