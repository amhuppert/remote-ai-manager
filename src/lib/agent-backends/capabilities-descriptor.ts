import { z } from "zod";
import type { AgentBackendId, ConversationBackendCapabilities } from "./types";

export const queueDeliveryTimingSchema = z.enum(["in_turn", "next_turn"]);
export type QueueDeliveryTiming = z.infer<typeof queueDeliveryTimingSchema>;

export interface QueueCapability {
  acceptsWhileRunning: boolean;
  deliveryTiming: QueueDeliveryTiming;
}

export function queueCapabilityForBackend(
  backend: AgentBackendId,
): QueueCapability {
  switch (backend) {
    case "claude":
      return { acceptsWhileRunning: true, deliveryTiming: "in_turn" };
    case "codex":
      return { acceptsWhileRunning: true, deliveryTiming: "next_turn" };
    default: {
      // A future backend id resolves as unsupported until it opts in.
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}

export function backendCapabilities(
  backend: AgentBackendId,
): ConversationBackendCapabilities {
  switch (backend) {
    case "claude":
      return {
        queueWhileRunning: true,
        askUserQuestion: true,
        preciseFork: true,
        portableMcpAtStart: true,
        portableMcpBetweenTurns: true,
        contextWindowMetrics: true,
      };
    case "codex":
      return {
        queueWhileRunning: false,
        askUserQuestion: true,
        preciseFork: false,
        portableMcpAtStart: true,
        portableMcpBetweenTurns: true,
        contextWindowMetrics: false,
      };
    default: {
      const _exhaustive: never = backend;
      return _exhaustive;
    }
  }
}
