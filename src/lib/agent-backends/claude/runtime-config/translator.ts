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
 *   - `disabledAgentNames` + `agentSuppressionStrategy` — list of sub-agents
 *     CC wants suppressed plus the verified strategy metadata. The runtime
 *     wires these into `Options.canUseTool` via
 *     `composeClaudeAgentCanUseTool()` at session creation; mid-session live
 *     flipping is unsupported on the installed SDK.
 *
 * Translation runs entirely below the runtime-config seam: the input is the
 * neutral cascade plus adapter-read native plugin records, and the output is
 * consumed within the same call frame (runtime creation or adapter apply).
 */

import {
  CLAUDE_AGENT_SUPPRESSION_STRATEGY,
  type ClaudeAgentSuppressionStrategy,
} from "./agent-suppression";
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
  /** Sub-agent names CC wants suppressed for this conversation. */
  disabledAgentNames: readonly string[];
  /** Verified suppression strategy metadata for the runtime to wire into
   * `Options.canUseTool` at session creation. */
  agentSuppressionStrategy: ClaudeAgentSuppressionStrategy;
}

export interface ClaudeRuntimeTranslationResult {
  config: ClaudeRuntimeCapabilityConfig;
  diagnostics: readonly ClaudePluginTranslationDiagnostic[];
}

export function translateClaudeRuntimeCapabilities(
  input: ClaudeRuntimeTranslationInput,
): ClaudeRuntimeTranslationResult {
  const skills = itemsForKind(input.cascade, "skills");
  const plugins = itemsForKind(input.cascade, "plugins");
  const agents = itemsForKind(input.cascade, "agents");

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

  const disabledAgentNames: string[] = [];
  for (const item of agents) {
    if (!item.enabled) {
      disabledAgentNames.push(item.itemId);
    }
  }

  return {
    config: {
      enabledPlugins: pluginTranslation.enabledPlugins,
      skillOverrides,
      disabledAgentNames,
      agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
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
