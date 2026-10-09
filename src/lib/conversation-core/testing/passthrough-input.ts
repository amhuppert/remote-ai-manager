import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";
import type {
  InputDelivery,
  PreparedTurnInput,
  TurnInputRequest,
} from "../turn-input";

/** Turn input with no contributions: the message as it is, kept and released on acceptance. */
export function passthroughTurnInput(
  request: TurnInputRequest,
): PreparedTurnInput {
  const delivery: InputDelivery = {
    dispatched: false,
    accepted: null,
    provenUndelivered: false,
  };
  return {
    promptText: request.promptText,
    dispatchPromptText: request.promptText,
    userPromptText: request.execution.turn.promptText,
    delivery,
    sending() {
      delivery.dispatched = true;
    },
    failed(error) {
      delivery.provenUndelivered = isPromptNotDeliveredFailure(error);
    },
    async accepted(backendRef) {
      delivery.accepted = { backendRef };
      await request.archive();
      await request.release();
    },
    async backendInit() {},
    settle: async () => true,
  };
}
