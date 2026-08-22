/**
 * Cursor's `BackendRuntimeConfigAdapter` (spec D18).
 *
 * Cursor declares no capability kinds: the worker attaches with
 * `settingSources: []`, so the SDK reads no user, project, team, or MDM
 * configuration and there is no skills/plugins/agents surface a resolved
 * cascade could reach. There is therefore nothing to translate — but there is
 * something to refuse. `validateResolvedCascade` rejects any kind the
 * descriptor does not declare, which is what turns "Cursor has no cascade" into
 * a loud, named result instead of a silent drop the operator would read as
 * applied.
 */

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

      // An empty cascade is the only one that reaches here, and applying it is
      // a no-op by construction — no provider call, nothing staged for the next
      // turn.
      return { status: "applied" };
    },
  };
}
