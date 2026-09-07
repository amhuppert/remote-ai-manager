import type { ConversationTurnExecution } from "../manager";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import type { TurnInterruption } from "../turn-result";

export function settledConversationTurn(
  result: Partial<AgentCallResult> = {},
  interruption?: TurnInterruption,
): ConversationTurnExecution {
  return {
    kind: "settled",
    turn: {
      attemptId: "test-attempt",
      status: "awaiting",
      pendingQuestion: null,
      outcome: {
        kind: "call_result",
        result: {
          backend: "claude",
          backendRef: null,
          capabilities:
            result.capabilities ??
            capabilityViewForBackend(result.backend ?? "claude"),
          usage: {},
          artifacts: [],
          outcome: { kind: "completed", text: "" },
          ...result,
        },
        ...(interruption ? { interruption } : {}),
      },
    },
  };
}
