import { assembleWorkflowResultsBlock } from "../assemble-user-blocks";
import type { ConversationActorDependencies } from "../actor-dependencies";
import type { PreparedTurnContribution } from "../turn-context";
import { getErrorMessage } from "@/lib/shared/errors";
import { createRequiredInputReceipt } from "./required-input-receipt";

type WorkflowResultDependencies = {
  effects: Pick<
    ConversationActorDependencies["effects"],
    "claimWorkflowResults" | "settleWorkflowResults" | "releaseWorkflowResults"
  >;
  log: ConversationActorDependencies["log"];
};

export async function prepareWorkflowResultContext(
  deps: WorkflowResultDependencies,
  input: Parameters<
    ConversationActorDependencies["effects"]["claimWorkflowResults"]
  >[0],
  ownReceipt: (finish: () => Promise<void>) => void,
): Promise<PreparedTurnContribution> {
  const fields = {
    conversationId: input.originConversationId,
    sessionName: input.sessionName,
    attemptId: input.attemptId,
  };
  let claimed;
  try {
    claimed = await deps.effects.claimWorkflowResults(input);
  } catch (error) {
    deps.log.warn("prompt.workflow_results_claim_failed", {
      ...fields,
      error: getErrorMessage(error),
    });
    return { block: null };
  }
  if (!claimed.length) return { block: null };
  let accepted = false;
  let released = false;
  const receipt = createRequiredInputReceipt(async () => {
    const settled = await deps.effects.settleWorkflowResults(input);
    deps.log.info("prompt.workflow_results_settled", {
      ...fields,
      claimed: claimed.length,
      settled,
    });
  });
  async function finish() {
    if (accepted) return receipt.finish();
    if (released) return;
    try {
      const count = await deps.effects.releaseWorkflowResults(input);
      released = true;
      deps.log.info("prompt.workflow_results_released", {
        ...fields,
        claimed: claimed.length,
        released: count,
      });
    } catch (error) {
      deps.log.error("prompt.workflow_results_release_failed", {
        ...fields,
        error: getErrorMessage(error),
      });
      throw error;
    }
  }
  ownReceipt(finish);
  deps.log.info("prompt.workflow_results_claimed", {
    ...fields,
    count: claimed.length,
    boundaries: claimed.map(({ executionId, boundarySeq }) => ({
      executionId,
      boundarySeq,
    })),
  });
  return {
    block: assembleWorkflowResultsBlock(claimed),
    onInputAccepted() {
      accepted = true;
      return receipt.onInputAccepted();
    },
    finish,
  };
}
