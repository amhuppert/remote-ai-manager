/**
 * Claude `BackendRuntimeConfigAdapter` — the concrete implementation behind
 * `descriptor.conversation.runtimeConfig`. Translation (neutral cascade →
 * `ClaudeRuntimeCapabilityConfig`) and native plugin record reads both happen
 * inside `apply()`, so no provider payload crosses the seam in either
 * direction.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";

import type { ConversationBackendRuntime } from "../../conversation";
import {
  validateResolvedCascade,
  type BackendRuntimeConfigAdapter,
  type ResolvedCapabilityCascade,
  type RuntimeConfigApplyResult,
} from "../../runtime-config";
import { claudeConversationCapabilities } from "../descriptor";
import { readClaudePluginNativeRecords } from "./plugin-native-records";
import {
  translateClaudeRuntimeCapabilities,
  claudeDeliveredCapabilities,
  type ClaudeRuntimeCapabilityConfig,
} from "./translator";

const logger = createLogger("claude:runtime-config-adapter");

/**
 * Result of a live capability-config apply attempt against the concrete
 * Claude conversation runtime. `skipped-turn-active` maps to the seam's
 * `{ status: "deferred", reason: "turn_active" }`.
 */
export type ClaudeCapabilityApplyResult =
  | { status: "applied" }
  | { status: "rejected"; error: string }
  | { status: "skipped-turn-active" };

/**
 * Claude-internal apply surface. Implemented by `ClaudeConversationRuntime`;
 * deliberately absent from the neutral `ConversationBackendRuntime` interface
 * so provider config types stay below the seam.
 */
export interface ClaudeCapabilityApplyTarget {
  readonly capabilityWorkingDirectory: string;
  applyCapabilityConfig(
    config: ClaudeRuntimeCapabilityConfig,
    resolved?: ResolvedCapabilityCascade,
  ): Promise<ClaudeCapabilityApplyResult>;
}

function isClaudeCapabilityApplyTarget(
  runtime: ConversationBackendRuntime,
): runtime is ConversationBackendRuntime & ClaudeCapabilityApplyTarget {
  return (
    runtime.backend === "claude" &&
    typeof (runtime as Partial<ClaudeCapabilityApplyTarget>)
      .applyCapabilityConfig === "function"
  );
}

export interface ClaudeRuntimeConfigAdapterDeps {
  readNativePluginRecords(
    worktreePath: string,
  ): ReturnType<typeof readClaudePluginNativeRecords>;
}

export function createClaudeRuntimeConfigAdapter(
  deps: ClaudeRuntimeConfigAdapterDeps = {
    readNativePluginRecords: (worktreePath) =>
      readClaudePluginNativeRecords(undefined, worktreePath),
  },
): BackendRuntimeConfigAdapter {
  const backend: AgentBackendId = "claude";
  return {
    backend,
    async apply(input: {
      runtime: ConversationBackendRuntime;
      resolved: ResolvedCapabilityCascade;
    }): Promise<RuntimeConfigApplyResult> {
      const validation = validateResolvedCascade({
        resolved: input.resolved,
        backend,
        capabilityKinds: claudeConversationCapabilities.capabilityKinds,
      });
      if (!validation.ok) {
        logger.warn("apply.invalid_cascade", { error: validation.error });
        return { status: "rejected", error: validation.error };
      }

      if (input.runtime.status !== "alive") {
        return { status: "rejected", error: "claude runtime is not alive" };
      }
      if (!isClaudeCapabilityApplyTarget(input.runtime)) {
        return {
          status: "rejected",
          error: "runtime does not expose the claude capability apply surface",
        };
      }

      let nativePluginRecords;
      try {
        nativePluginRecords = await deps.readNativePluginRecords(
          input.runtime.capabilityWorkingDirectory,
        );
      } catch (err) {
        const error = getErrorMessage(err);
        logger.error("apply.native_plugin_records_unreadable", { error });
        return {
          status: "rejected",
          error: `native plugin records unreadable: ${error}`,
        };
      }

      const translation = translateClaudeRuntimeCapabilities({
        cascade: input.resolved,
        nativePluginRecords,
      });
      for (const diagnostic of translation.diagnostics) {
        logger.warn("apply.translation_diagnostic", {
          code: diagnostic.code,
          pluginId: diagnostic.pluginId,
          message: diagnostic.message,
        });
      }

      let result: ClaudeCapabilityApplyResult;
      try {
        result = await input.runtime.applyCapabilityConfig(
          translation.config,
          claudeDeliveredCapabilities(input.resolved),
        );
      } catch (err) {
        return { status: "rejected", error: getErrorMessage(err) };
      }

      logger.info("apply.result", {
        status: result.status,
        pluginCount: Object.keys(translation.config.enabledPlugins).length,
        skillOverrideCount: Object.keys(translation.config.skillOverrides)
          .length,
      });

      if (result.status === "skipped-turn-active") {
        return { status: "deferred", reason: "turn_active" };
      }
      return result;
    },
  };
}
