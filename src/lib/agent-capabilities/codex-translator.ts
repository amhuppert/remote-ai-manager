/**
 * Codex capability translator — verification-gated.
 *
 * The installed `@openai/codex-sdk` typings expose only a generic
 * `CodexOptions.config` pass-through; they do not declare a typed per-skill or
 * per-plugin enablement key. Until those keys are verified against the
 * installed Codex CLI and SDK, the translator deliberately:
 *
 * - Refuses to emit any `CodexOptions.config` payload for the skills cascade
 *   and surfaces a `codex-skill-config-key-unverified` diagnostic so the
 *   conversation falls back to Codex's native defaults rather than silently
 *   shipping configuration-only flags the agent ignores.
 * - Refuses to emit any plugin payload and surfaces a `codex-plugins-unavailable`
 *   diagnostic that mirrors the metadata's `unavailable-pending-verification`
 *   discovery state.
 *
 * When a future implementation verifies the concrete config keys for either
 * cascade, that work must (1) update this translator to emit them, (2) update
 * the metadata registry to drop the verification gate, and (3) extend the
 * focused tests below with the verified emission shape.
 */

import type { AgentCapabilityCascadeKind } from "./metadata";

export interface CodexResolvedSkill {
  itemId: string;
  enabled: boolean;
  sourcePath: string;
}

export interface CodexCapabilityResolvedInput {
  skills: readonly CodexResolvedSkill[];
  pluginCascadeRequested: boolean;
  pluginItemCount: number;
}

export interface CodexCapabilityTranslationDiagnostic {
  code: string;
  severity: "warning" | "error";
  cascadeKind: AgentCapabilityCascadeKind;
  message: string;
}

export interface CodexCapabilityTranslationResult {
  /** Object that will be merged into `CodexOptions.config` at turn start.
   * Empty when no cascade has a verified emission path. */
  config: Record<string, never>;
  diagnostics: readonly CodexCapabilityTranslationDiagnostic[];
  emittedCascadeKinds: readonly AgentCapabilityCascadeKind[];
  /** Confirms the translator never claims live application. Codex is staged
   * for the next turn only; the runtime apply service must respect this. */
  applySemantics: "next-turn";
}

export function translateCodexCapabilities(
  input: CodexCapabilityResolvedInput,
): CodexCapabilityTranslationResult {
  const diagnostics: CodexCapabilityTranslationDiagnostic[] = [];

  if (input.skills.length > 0) {
    diagnostics.push({
      code: "codex-skill-config-key-unverified",
      severity: "warning",
      cascadeKind: "codex-skills",
      message:
        "Codex skill enablement cannot be emitted: no `CodexOptions.config` key for per-skill enablement is verified against the installed @openai/codex-sdk typings. Cascade falls back to Codex native skill resolution.",
    });
  }

  if (input.pluginCascadeRequested && input.pluginItemCount > 0) {
    diagnostics.push({
      code: "codex-plugins-unavailable",
      severity: "warning",
      cascadeKind: "codex-plugins",
      message:
        "Codex plugin overrides cannot be emitted: plugin discovery and translation are pending verification against the installed Codex SDK.",
    });
  }

  return {
    config: {},
    diagnostics,
    emittedCascadeKinds: [],
    applySemantics: "next-turn",
  };
}
