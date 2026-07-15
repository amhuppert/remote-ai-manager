/**
 * Codex runtime capability translation + `BackendRuntimeConfigAdapter`.
 *
 * Emits the verified TOML override shape that `@openai/codex-sdk` accepts
 * through `CodexOptions.config` — `skills.config[]` entries with
 * `{ enabled, name }` per resolved codex-skill and `plugins."NAME".enabled`
 * per resolved codex-plugin (verified against the Codex `config.schema.json`
 * `SkillsConfig` and `PluginConfig` definitions). The SDK passes this object
 * through verbatim via `flattenConfigOverrides`, which handles nested objects
 * and `@`-bearing keys correctly.
 *
 * Codex rebuilds its `CodexOptions` per turn, so applying a config only
 * stores it on the runtime for next-turn ingestion — there is no live-apply
 * path and the adapter never returns a turn-active deferral.
 */

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";

import type { ConversationBackendRuntime } from "../conversation";
import {
  validateResolvedCascade,
  type BackendRuntimeConfigAdapter,
  type ResolvedCapabilityCascade,
  type ResolvedCapabilityItem,
  type RuntimeConfigApplyResult,
} from "../runtime-config";
import { codexConversationCapabilities } from "./descriptor";

const logger = createLogger("codex:runtime-config-adapter");

export interface CodexCapabilityEmittedConfig {
  skills?: { config: { enabled: boolean; name: string }[] };
  plugins?: Record<string, { enabled: boolean }>;
}

export interface CodexRuntimeCapabilityConfig {
  /** Pass-through object merged into `CodexOptions.config` at next-turn
   * start. */
  config: CodexCapabilityEmittedConfig;
}

export function translateCodexRuntimeCapabilities(
  cascade: ResolvedCapabilityCascade,
): CodexRuntimeCapabilityConfig {
  const skills = itemsForKind(cascade, "skills");
  const plugins = itemsForKind(cascade, "plugins");

  const config: CodexCapabilityEmittedConfig = {};

  if (skills.length > 0) {
    config.skills = {
      // Codex skill item ids double as the skill names the SDK matches on.
      config: skills.map((skill) => ({
        enabled: skill.enabled,
        name: skill.itemId,
      })),
    };
  }

  if (plugins.length > 0) {
    const pluginConfig: Record<string, { enabled: boolean }> = {};
    for (const plugin of plugins) {
      pluginConfig[plugin.itemId] = { enabled: plugin.enabled };
    }
    config.plugins = pluginConfig;
  }

  return { config };
}

function itemsForKind(
  cascade: ResolvedCapabilityCascade,
  kind: "skills" | "plugins",
): readonly ResolvedCapabilityItem[] {
  return cascade.kinds.find((entry) => entry.kind === kind)?.items ?? [];
}

/**
 * Result of pushing a refreshed capability config into the concrete Codex
 * runtime between turns. Codex only needs to store the new config; the next
 * turn picks it up automatically.
 */
export type CodexCapabilityApplyResult =
  | { status: "applied" }
  | { status: "rejected"; error: string };

/**
 * Codex-internal apply surface. Implemented by `CodexConversationRuntime`;
 * deliberately absent from the neutral `ConversationBackendRuntime` interface
 * so provider config types stay below the seam.
 */
export interface CodexCapabilityApplyTarget {
  applyCapabilityConfig(
    config: CodexRuntimeCapabilityConfig,
  ): Promise<CodexCapabilityApplyResult>;
}

function isCodexCapabilityApplyTarget(
  runtime: ConversationBackendRuntime,
): runtime is ConversationBackendRuntime & CodexCapabilityApplyTarget {
  return (
    runtime.backend === "codex" &&
    typeof (runtime as Partial<CodexCapabilityApplyTarget>)
      .applyCapabilityConfig === "function"
  );
}

export function createCodexRuntimeConfigAdapter(): BackendRuntimeConfigAdapter {
  const backend: AgentBackendId = "codex";
  return {
    backend,
    async apply(input: {
      runtime: ConversationBackendRuntime;
      resolved: ResolvedCapabilityCascade;
    }): Promise<RuntimeConfigApplyResult> {
      const validation = validateResolvedCascade({
        resolved: input.resolved,
        backend,
        capabilityKinds: codexConversationCapabilities.capabilityKinds,
      });
      if (!validation.ok) {
        logger.warn("apply.invalid_cascade", { error: validation.error });
        return { status: "rejected", error: validation.error };
      }

      if (input.runtime.status !== "alive") {
        return { status: "rejected", error: "codex runtime is closed" };
      }
      if (!isCodexCapabilityApplyTarget(input.runtime)) {
        return {
          status: "rejected",
          error: "runtime does not expose the codex capability apply surface",
        };
      }

      const translated = translateCodexRuntimeCapabilities(input.resolved);

      let result: CodexCapabilityApplyResult;
      try {
        result = await input.runtime.applyCapabilityConfig(translated);
      } catch (err) {
        return { status: "rejected", error: getErrorMessage(err) };
      }

      logger.info("apply.result", {
        status: result.status,
        configKeys: Object.keys(translated.config).length,
      });
      return result;
    },
  };
}
