import { createLogger } from "@/lib/logging";

import type { ConversationBackendRuntime } from "../conversation";
import {
  validateResolvedCascade,
  type BackendRuntimeConfigAdapter,
  type ResolvedCapabilityCascade,
  type RuntimeConfigApplyResult,
} from "../runtime-config";
import { CURSOR_BACKEND_ID } from "./backend-id";
import { cursorConversationCapabilities } from "./descriptor";

const logger = createLogger("cursor:runtime-config-adapter");

export function createCursorRuntimeConfigAdapter(): BackendRuntimeConfigAdapter {
  return {
    backend: CURSOR_BACKEND_ID,
    async apply(input: {
      runtime: ConversationBackendRuntime;
      resolved: ResolvedCapabilityCascade;
    }): Promise<RuntimeConfigApplyResult> {
      const validation = validateResolvedCascade({
        resolved: input.resolved,
        backend: CURSOR_BACKEND_ID,
        capabilityKinds: cursorConversationCapabilities.capabilityKinds,
      });
      if (!validation.ok) {
        logger.warn("apply.invalid_cascade", { error: validation.error });
        return { status: "rejected", error: validation.error };
      }

      if (input.runtime.status !== "alive") {
        return { status: "rejected", error: "cursor runtime is closed" };
      }

      if (input.resolved.kinds.length) {
        return {
          status: "deferred",
          reason: "next_conversation",
        };
      }
      return { status: "applied" };
    },
  };
}
