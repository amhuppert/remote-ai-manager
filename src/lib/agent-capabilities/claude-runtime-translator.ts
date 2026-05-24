/**
 * Claude runtime capability translator.
 *
 * Converts the three Claude cascades' resolved views into the in-memory
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
 * Per-cascade failure isolation: a translation failure for one cascade
 * (e.g. plugin map produces stale-id diagnostics) does not poison the other
 * two — each cascade builds its emit independently and the composer falls
 * back to native defaults only for the failed cascade.
 *
 * Plugin-contributed child behavior (skills/agents contributed by a plugin)
 * is preserved at apply time through `reloadPlugins()` semantics in the
 * Claude runtime port; from the translator's perspective, a plugin-disabled
 * child's `effectiveState.enabled === false` already flows through the
 * resolver's parent-child overlay, so no extra translator branch is needed.
 */

import {
  CLAUDE_AGENT_SUPPRESSION_STRATEGY,
  type ClaudeAgentSuppressionStrategy,
} from "./claude-agent-suppression";
import {
  translateClaudePluginEnablement,
  type ClaudePluginNativeRecord,
  type ClaudePluginOverrideState,
  type ClaudePluginTranslationDiagnostic,
} from "./claude-plugin-translator";

import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityViewResponse,
} from "./schemas";

export interface ClaudeRuntimeTranslationInput {
  skillsView: AgentCapabilityViewResponse | undefined;
  pluginsView: AgentCapabilityViewResponse | undefined;
  agentsView: AgentCapabilityViewResponse | undefined;
  /**
   * Adapter-private native plugin snapshots from `discoverClaudePlugins()`.
   * The plugin translator reads these to produce a minimal `enabledPlugins`
   * delta against the native settings entries; downstream callers never see
   * them.
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

interface ClaudeCascadeEmission {
  cascadeKind: "claude-skills" | "claude-plugins" | "claude-agents";
  /**
   * Rows that contributed to the emitted payload for this cascade. Used by
   * the composer to compute the per-cascade runtime hash and to seed
   * `pendingItemIds` on the conversation runtime apply state.
   */
  emittedRows: readonly { itemId: string; enabled: boolean }[];
}

export interface ClaudeRuntimeTranslationResult {
  config: ClaudeRuntimeCapabilityConfig;
  diagnostics: readonly AgentCapabilityDiagnostic[];
  /**
   * Per-cascade emission record. The composer hashes these for pendingHash
   * seeding and skips cascades whose view was undefined (the upstream
   * discovery failed) without affecting the others.
   */
  emissions: readonly ClaudeCascadeEmission[];
}

export function translateClaudeRuntimeCapabilities(
  input: ClaudeRuntimeTranslationInput,
): ClaudeRuntimeTranslationResult {
  const diagnostics: AgentCapabilityDiagnostic[] = [];
  const emissions: ClaudeCascadeEmission[] = [];

  const skillResult = translateSkills(input.skillsView);
  if (skillResult) {
    emissions.push(skillResult.emission);
  }

  const pluginResult = translatePlugins(
    input.pluginsView,
    input.nativePluginRecords,
  );
  if (pluginResult) {
    diagnostics.push(...pluginResult.diagnostics);
    emissions.push(pluginResult.emission);
  }

  const agentResult = translateAgents(input.agentsView);
  if (agentResult) {
    emissions.push(agentResult.emission);
  }

  return {
    config: {
      enabledPlugins: pluginResult?.enabledPlugins ?? {},
      skillOverrides: skillResult?.skillOverrides ?? {},
      disabledAgentNames: agentResult?.disabledAgentNames ?? [],
      agentSuppressionStrategy: CLAUDE_AGENT_SUPPRESSION_STRATEGY,
    },
    diagnostics,
    emissions,
  };
}

interface SkillTranslationResult {
  skillOverrides: Record<string, "on" | "off">;
  emission: ClaudeCascadeEmission;
}

function translateSkills(
  view: AgentCapabilityViewResponse | undefined,
): SkillTranslationResult | undefined {
  if (!view) return undefined;
  const skillOverrides: Record<string, "on" | "off"> = {};
  const emittedRows: { itemId: string; enabled: boolean }[] = [];

  for (const row of view.items) {
    if (!row.runtimeEmittable) continue;
    // Only CC-explicit decisions go into the SDK flag layer; rows still
    // resolved at the native default are left to Claude's own per-mode
    // skill resolution.
    if (row.effectiveState.originLayer === "native") continue;
    skillOverrides[row.itemId] = row.effectiveState.enabled ? "on" : "off";
    emittedRows.push({
      itemId: row.itemId,
      enabled: row.effectiveState.enabled,
    });
  }

  return {
    skillOverrides,
    emission: { cascadeKind: "claude-skills", emittedRows },
  };
}

interface PluginTranslationResult {
  enabledPlugins: Record<string, boolean>;
  diagnostics: readonly AgentCapabilityDiagnostic[];
  emission: ClaudeCascadeEmission;
}

function translatePlugins(
  view: AgentCapabilityViewResponse | undefined,
  nativeRecords: readonly ClaudePluginNativeRecord[],
): PluginTranslationResult | undefined {
  if (!view) return undefined;
  const overrides = new Map<string, ClaudePluginOverrideState>();
  const emittedRows: { itemId: string; enabled: boolean }[] = [];

  for (const row of view.items) {
    // Explicit-override rows (including stale ones) are forwarded to the
    // underlying plugin translator so it can produce its plugin-specific
    // stale-id diagnostic. Native-origin rows are skipped because they would
    // be no-ops against the native settings entry.
    if (row.effectiveState.originLayer !== "native") {
      overrides.set(row.itemId, {
        resolvedEnabled: row.effectiveState.enabled,
      });
    }
    // Only runtime-emittable rows contribute to the emission so stale rows
    // do not pollute the cascade hash or pending-item set.
    if (row.runtimeEmittable) {
      emittedRows.push({
        itemId: row.itemId,
        enabled: row.effectiveState.enabled,
      });
    }
  }

  const translation = translateClaudePluginEnablement({
    native: nativeRecords,
    overrides,
  });

  const diagnostics: AgentCapabilityDiagnostic[] = translation.diagnostics.map(
    (diag) => liftPluginDiagnostic(diag),
  );

  return {
    enabledPlugins: translation.enabledPlugins,
    diagnostics,
    emission: { cascadeKind: "claude-plugins", emittedRows },
  };
}

interface AgentTranslationResult {
  disabledAgentNames: readonly string[];
  emission: ClaudeCascadeEmission;
}

function translateAgents(
  view: AgentCapabilityViewResponse | undefined,
): AgentTranslationResult | undefined {
  if (!view) return undefined;
  const disabled: string[] = [];
  const emittedRows: { itemId: string; enabled: boolean }[] = [];

  for (const row of view.items) {
    if (!row.runtimeEmittable) continue;
    emittedRows.push({
      itemId: row.itemId,
      enabled: row.effectiveState.enabled,
    });
    if (!row.effectiveState.enabled) {
      disabled.push(row.itemId);
    }
  }

  return {
    disabledAgentNames: disabled,
    emission: { cascadeKind: "claude-agents", emittedRows },
  };
}

function liftPluginDiagnostic(
  diag: ClaudePluginTranslationDiagnostic,
): AgentCapabilityDiagnostic {
  return {
    severity: "warning",
    code: diag.code,
    message: diag.message,
    cascadeKind: "claude-plugins",
    backend: "claude",
    itemId: diag.pluginId,
  };
}
