import type { ConversationTurnSubmission, TurnAdmission } from "../turn-spec";

/** Queue tests capture the admission boundary without executing a provider. */
export function createQueueAdmissionFixture(
  onSubmit: (input: ConversationTurnSubmission) => void,
) {
  return async (input: ConversationTurnSubmission): Promise<TurnAdmission> => {
    onSubmit(input);
    const completed = Promise.resolve({
      attemptId: "queue-test",
      outcome: {
        kind: "not_started" as const,
        reason: "configuration" as const,
        message: "Queue test boundary",
      },
      status: "awaiting" as const,
      pendingQuestion: null,
    });
    return {
      kind: "accepted",
      turn: { attemptId: "queue-test", completed, cancel: () => completed },
    };
  };
}
