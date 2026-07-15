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
import type { ConversationRuntimeState } from "../runtime-state";

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
    /** Closes the live backend runtime when the safety-net timeout fires. */
    closeRuntime(): void;
  },
): TurnAbortWiring {
  const { runtimeState } = input;

  if (runtimeState.abortController.signal.aborted) {
    logger.info("prompt.abort_controller_refreshed", {
      sessionName: input.sessionName,
      backend: input.backend,
      conversationId: input.conversationId,
    });
    runtimeState.abortController = new AbortController();
  }
  const abortController = runtimeState.abortController;
  deps.registerAbortController(input.conversationId, abortController);

  let timeoutFired = false;
  logger.debug("prompt.timeout.resolved", {
    sessionName: input.sessionName,
    backend: input.backend,
    timeoutMs: input.timeoutMs,
    timeoutEnabled: input.timeoutMs > 0,
  });
  if (input.timeoutMs > 0) {
    runtimeState.timeoutHandle = setTimeout(() => {
      timeoutFired = true;
      logger.warn("prompt.timeout", {
        sessionName: input.sessionName,
        timeoutMs: input.timeoutMs,
      });
      abortController.abort();
      input.closeRuntime();
    }, input.timeoutMs);
  }

  return {
    abortController,
    timeoutFired: () => timeoutFired,
    cleanup: () => {
      if (runtimeState.timeoutHandle) {
        clearTimeout(runtimeState.timeoutHandle);
        runtimeState.timeoutHandle = undefined;
      }
      deps.unregisterAbortController(input.conversationId, abortController);
    },
  };
}
