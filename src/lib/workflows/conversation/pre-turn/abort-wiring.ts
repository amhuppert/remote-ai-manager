/** Arms timeout and inactivity cancellation on the admitted controller. */

import { createLogger } from "@/lib/logging";
import {
  createStallWatchdog,
  type StallWatchdog,
} from "@/lib/agent-backends/stall-watchdog";
import type { ConversationRuntimeState } from "../runtime-state";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation-actor");

export interface TurnAbortWiring {
  abortController: AbortController;
  /** True once the safety-net timeout fired (read on abort exit paths). */
  timeoutFired(): boolean;
  /** True once the inactivity watchdog fired (read on abort exit paths). */
  stallFired(): boolean;
  /** Record backend activity: resets the inactivity deadline. */
  notifyActivity(): void;
  /** Clear the turn timeout and inactivity watchdog. */
  cleanup(): void;
}

export function wireTurnAbort(input: {
  runtimeState: Pick<
    ConversationRuntimeState,
    "abortController" | "timeoutHandle"
  >;
  conversationId: string;
  sessionName: string;
  backend: string;
  timeoutMs: number;
  /**
   * Per-turn inactivity bound (0 disables). Fed by `notifyActivity()` from
   * the turn's backend-event stream; a turn with no events for this long is
   * presumed hung and torn down like a timeout, but reported as `stalled`.
   */
  stallTimeoutMs?: number;
}): TurnAbortWiring {
  const { runtimeState } = input;

  const abortController = runtimeState.abortController;

  let timeoutFired = false;
  logger.debug("prompt.timeout.resolved", {
    ...scopeRefFromStoreSessionName(input.sessionName),
    backend: input.backend,
    timeoutMs: input.timeoutMs,
    timeoutEnabled: input.timeoutMs > 0,
  });
  if (input.timeoutMs > 0) {
    runtimeState.timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      logger.warn("prompt.timeout", {
        ...scopeRefFromStoreSessionName(input.sessionName),
        timeoutMs: input.timeoutMs,
      });
      abortController.abort("timeout");
    }, input.timeoutMs);
  }

  const stallTimeoutMs = input.stallTimeoutMs ?? 0;
  const stallWatchdog: StallWatchdog = createStallWatchdog({
    stallTimeoutMs,
    onStall: () => {
      logger.warn("prompt.stalled", {
        ...scopeRefFromStoreSessionName(input.sessionName),
        backend: input.backend,
        conversationId: input.conversationId,
        stallTimeoutMs,
      });
      abortController.abort("stalled");
    },
  });

  return {
    abortController,
    timeoutFired: () => timeoutFired,
    stallFired: () => stallWatchdog.fired(),
    notifyActivity: () => stallWatchdog.touch(),
    cleanup: () => {
      if (runtimeState.timeoutHandle) {
        clearTimeout(runtimeState.timeoutHandle);
        runtimeState.timeoutHandle = undefined;
      }
      stallWatchdog.cancel();
    },
  };
}
