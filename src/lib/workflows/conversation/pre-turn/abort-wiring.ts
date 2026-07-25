/**
 * Pre-turn step: abort-controller and safety-net-timeout wiring.
 *
 * Hides three lifecycle decisions: a controller left aborted by a previous
 * turn is refreshed (an AbortController is single-use); the timeout handle
 * lives on the shared runtime state so out-of-band cleanup (manager stop,
 * runtime-state cleanup) can cancel it; and on timeout the controller aborts
 * BEFORE the runtime closes so the backend's `signal.aborted` check
 * classifies the failure as `aborted` rather than a generic error.
 */

import { createLogger } from "@/lib/logging";
import {
  createStallWatchdog,
  type StallWatchdog,
} from "@/lib/agent-backends/stall-watchdog";
import type { ConversationRuntimeState } from "../runtime-state";
import { scopeRefFromStoreSessionName } from "@/lib/conversations/conversation-target";

const logger = createLogger("conversation-actor");

export interface AbortWiringDeps {
  registerAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;
  unregisterAbortController(
    conversationId: string,
    controller: AbortController,
  ): void;
}

export interface TurnAbortWiring {
  abortController: AbortController;
  /** True once the safety-net timeout fired (read on abort exit paths). */
  timeoutFired(): boolean;
  /** True once the inactivity watchdog fired (read on abort exit paths). */
  stallFired(): boolean;
  /** Record backend activity: resets the inactivity deadline. */
  notifyActivity(): void;
  /** Clear the timeout and unregister the controller (turn `finally`). */
  cleanup(): void;
}

export function wireTurnAbort(
  deps: AbortWiringDeps,
  input: {
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
    /** Closes the live backend runtime when the safety-net timeout fires. */
    closeRuntime(): void;
  },
): TurnAbortWiring {
  const { runtimeState } = input;

  if (runtimeState.abortController.signal.aborted) {
    logger.info("prompt.abort_controller_refreshed", {
      ...scopeRefFromStoreSessionName(input.sessionName),
      backend: input.backend,
      conversationId: input.conversationId,
    });
    runtimeState.abortController = new AbortController();
  }
  const abortController = runtimeState.abortController;
  deps.registerAbortController(input.conversationId, abortController);

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
      abortController.abort();
      input.closeRuntime();
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
      abortController.abort();
      input.closeRuntime();
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
      deps.unregisterAbortController(input.conversationId, abortController);
    },
  };
}
