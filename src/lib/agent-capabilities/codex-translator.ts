/**
 * Codex capability translator.
 *
 * Emits the verified TOML override shape that `@openai/codex-sdk` accepts
 * through `CodexOptions.config` — `skills.config[]` entries with
 * `{ enabled, name }` per resolved codex-skill and `plugins."NAME".enabled`
 * per resolved codex-plugin (verified against the Codex `config.schema.json`
 * `SkillsConfig` and `PluginConfig` definitions). The SDK passes this
 * object through verbatim via `flattenConfigOverrides`, which handles
 * nested objects and `@`-bearing keys correctly.
 */

import type { AgentCapabilityCascadeKind } from "./metadata";

export interface CodexResolvedSkill {
  itemId: string;
  name: string;
  enabled: boolean;
  sourcePath: string;
}

export interface CodexResolvedPlugin {
  itemId: string;
  enabled: boolean;
}

export interface CodexCapabilityResolvedInput {
  skills: readonly CodexResolvedSkill[];
  plugins: readonly CodexResolvedPlugin[];
}

export interface CodexCapabilityTranslationDiagnostic {
  code: string;
  severity: "warning" | "error";
  cascadeKind: AgentCapabilityCascadeKind;
  message: string;
}

export interface CodexCapabilityEmittedConfig {
  skills?: { config: { enabled: boolean; name: string }[] };
  plugins?: Record<string, { enabled: boolean }>;
}

export interface CodexCapabilityTranslationResult {
  /** Object that will be merged into `CodexOptions.config` at turn start. */
  config: CodexCapabilityEmittedConfig;
  diagnostics: readonly CodexCapabilityTranslationDiagnostic[];
  emittedCascadeKinds: readonly AgentCapabilityCascadeKind[];
  /** Confirms the translator never claims live application. Codex is staged
   * for the next turn only; the runtime apply service must respect this. */
  applySemantics: "next-turn";
}

export function translateCodexCapabilities(
  input: CodexCapabilityResolvedInput,
): CodexCapabilityTranslationResult {
  const config: CodexCapabilityEmittedConfig = {};
  const emittedCascadeKinds: AgentCapabilityCascadeKind[] = [];

  if (input.skills.length > 0) {
    config.skills = {
      config: input.skills.map((skill) => ({
        enabled: skill.enabled,
        name: skill.name,
      })),
    };
    emittedCascadeKinds.push("codex-skills");
  }

  if (input.plugins.length > 0) {
    const plugins: Record<string, { enabled: boolean }> = {};
    for (const plugin of input.plugins) {
      plugins[plugin.itemId] = { enabled: plugin.enabled };
    }
    config.plugins = plugins;
    emittedCascadeKinds.push("codex-plugins");
  }

  return {
    config,
    diagnostics: [],
    emittedCascadeKinds,
    applySemantics: "next-turn",
  };
}
