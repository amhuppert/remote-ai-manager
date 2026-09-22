/**
 * Claude runtime capability translator.
 *
 * Converts a backend-neutral resolved capability cascade into the in-memory
 * runtime payload the Claude conversation runtime injects into
 * `QuerySessionOptions`:
 *
 *   - `enabledPlugins`  — minimal flag-layer delta computed by
 *     `translateClaudePluginEnablement()`. Plugins whose resolved state
 *     matches the native settings entry are deliberately omitted so the SDK
 *     preserves native extended values (e.g. `{ version: "1.2.0" }`) verbatim.
 *   - `skillOverrides`  — CC's explicit on/off intent per skill. Skills with
 *     no CC override (resolved via native default) are omitted so Claude's
 *     own per-mode skill resolution stays authoritative.
 * Translation runs entirely below the runtime-config seam: the input is the
 * neutral cascade plus adapter-read native plugin records, and the output is
 * consumed within the same call frame (runtime creation or adapter apply).
 */

import {
  translateClaudePluginEnablement,
  type ClaudePluginNativeRecord,
  type ClaudePluginOverrideState,
  type ClaudePluginTranslationDiagnostic,
} from "./plugin-translator";

import type {
  ResolvedCapabilityCascade,
  ResolvedCapabilityItem,
} from "../../runtime-config";

export interface ClaudeRuntimeTranslationInput {
  cascade: ResolvedCapabilityCascade;
  /**
   * Adapter-private native plugin snapshots from
   * `readClaudePluginNativeRecords()`. The plugin translator reads these to
   * produce a minimal `enabledPlugins` delta against the native settings
   * entries; nothing above the seam ever sees them.
   */
  nativePluginRecords: readonly ClaudePluginNativeRecord[];
}

export interface ClaudeRuntimeCapabilityConfig {
  /** Minimal SDK-flag-layer delta. Omits any plugin whose resolved state
   * matches the native settings entry — preserves native extended values. */
  enabledPlugins: Record<string, boolean>;
  /** Per-skill on/off intent; populated only when CC has an explicit
   * override (resolved origin layer is not `native`). */
  skillOverrides: Record<string, "on" | "off">;
}

export interface ClaudeRuntimeTranslationResult {
  config: ClaudeRuntimeCapabilityConfig;
  diagnostics: readonly ClaudePluginTranslationDiagnostic[];
}

export function translateClaudeRuntimeCapabilities(
  input: ClaudeRuntimeTranslationInput,
): ClaudeRuntimeTranslationResult {
  const supported = claudeDeliveredCapabilities(input.cascade);
  const skills = itemsForKind(supported, "skills");
  const plugins = itemsForKind(input.cascade, "plugins");

  const skillOverrides: Record<string, "on" | "off"> = {};
  for (const item of skills) {
    // Only CC-explicit decisions go into the SDK flag layer; rows still
    // resolved at the native default are left to Claude's own per-mode
    // skill resolution.
    if (item.originLayer === "native") continue;
    skillOverrides[item.itemId] = item.enabled ? "on" : "off";
  }

  const overrides = new Map<string, ClaudePluginOverrideState>();
  for (const item of plugins) {
    if (item.originLayer === "native") continue;
    overrides.set(item.itemId, { resolvedEnabled: item.enabled });
  }
  const pluginTranslation = translateClaudePluginEnablement({
    native: input.nativePluginRecords,
    overrides,
  });

  return {
    config: {
      enabledPlugins: pluginTranslation.enabledPlugins,
      skillOverrides,
    },
    diagnostics: pluginTranslation.diagnostics,
  };
}

function itemsForKind(
  cascade: ResolvedCapabilityCascade,
  kind: "skills" | "plugins" | "agents",
): readonly ResolvedCapabilityItem[] {
  return cascade.kinds.find((entry) => entry.kind === kind)?.items ?? [];
}

/** Native flags cannot select individual agents or plugin-owned skills. */
export function claudeDeliveredCapabilities(
  cascade: ResolvedCapabilityCascade,
): ResolvedCapabilityCascade {
  return {
    ...cascade,
    kinds: cascade.kinds.map((kind) => ({
      ...kind,
      items:
        kind.kind === "agents"
          ? []
          : kind.kind === "skills"
            ? kind.items.filter((item) => !item.itemId.includes(":"))
            : kind.items,
    })),
  };
}
