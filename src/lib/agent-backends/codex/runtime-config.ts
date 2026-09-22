import { discoverCodexSkillSelectors } from "./skill-discovery";
import type { CodexNativeSkillSelector } from "./skill-catalog";
import os from "node:os";
import { codexSkillPath } from "./skill-identity";
/**
 * Codex capability selection stays below the backend seam. Durable source ids
 * become native path selectors, and explicit CC decisions merge with the
 * effective native selector array before launch. Staging a config does not
 * acknowledge delivery; the next accepted turn supplies that receipt.
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
  skills?: { config: { enabled: boolean; name?: string; path?: string }[] };
  plugins?: Record<string, { enabled: boolean }>;
}

export interface CodexRuntimeCapabilityConfig {
  /** Pass-through object merged into `CodexOptions.config` at next-turn
   * start. */
  config: CodexCapabilityEmittedConfig;
  capabilities?: ResolvedCapabilityCascade;
}

/** A flag-layer array replaces native selectors; retain untargeted decisions. */
export async function mergeCodexNativeSkillSelectors(
  config: CodexCapabilityEmittedConfig,
  worktreePath: string,
  readSelectors: (
    cwd: string,
  ) => Promise<
    readonly CodexNativeSkillSelector[]
  > = discoverCodexSkillSelectors,
): Promise<CodexCapabilityEmittedConfig> {
  if (!config.skills) return config;
  const native = await readSelectors(worktreePath);
  const explicit = config.skills.config;
  return {
    ...config,
    skills: {
      config: [
        ...native.filter(
          (entry) =>
            !explicit.some((decision) =>
              decision.path
                ? decision.path === entry.path
                : decision.name === entry.name,
            ),
        ),
        ...explicit,
      ],
    },
  };
}

export function translateCodexRuntimeCapabilities(
  cascade: ResolvedCapabilityCascade,
  worktreePath: string = process.cwd(),
): CodexRuntimeCapabilityConfig {
  const skills = itemsForKind(cascade, "skills").filter(
    (skill) => skill.originLayer !== "native",
  );
  const plugins = itemsForKind(cascade, "plugins");

  const config: CodexCapabilityEmittedConfig = {};

  if (skills.length > 0) {
    config.skills = {
      config: skills.flatMap((skill) => {
        const skillPath = codexSkillPath(
          skill.itemId,
          worktreePath,
          os.homedir(),
        );
        return skillPath ? [{ enabled: skill.enabled, path: skillPath }] : [];
      }),
    };
    if (config.skills.config.length === 0) delete config.skills;
  }

  if (plugins.length > 0) {
    const pluginConfig: Record<string, { enabled: boolean }> = {};
    for (const plugin of plugins) {
      pluginConfig[plugin.itemId] = { enabled: plugin.enabled };
    }
    config.plugins = pluginConfig;
  }

  return { config, capabilities: cascade };
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
  | { status: "deferred"; reason: "next_turn" }
  | { status: "rejected"; error: string };

/**
 * Codex-internal apply surface. Implemented by `CodexConversationRuntime`;
 * deliberately absent from the neutral `ConversationBackendRuntime` interface
 * so provider config types stay below the seam.
 */
export interface CodexCapabilityApplyTarget {
  readonly capabilityWorkingDirectory: string;
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

      const translated = translateCodexRuntimeCapabilities(
        input.resolved,
        input.runtime.capabilityWorkingDirectory,
      );

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
