/**
 * Codex runtime capability translator.
 *
 * Adapts the verification-gated `translateCodexCapabilities` primitive to the
 * canonical `AgentCapabilityViewResponse` shape produced by the cascade
 * resolver. The runtime translator is responsible for:
 *
 *   - Building the underlying translator's input from the resolved skill view
 *     (only `runtimeEmittable` rows participate; verification-gated cascades
 *     produce no emittable rows by design, so the skill input ends up empty).
 *   - Lifting the underlying translator's diagnostics to the cross-cutting
 *     `AgentCapabilityDiagnostic` shape with `backend: "codex"` and the
 *     correct `cascadeKind` so the composer can surface them alongside other
 *     cascade diagnostics in a single envelope.
 *   - Producing per-cascade `ClaudeCascadeEmission`-shaped records so the
 *     composer can hash + seed pending runtime state without branching on
 *     backend. For Codex, both cascades currently emit empty row sets because
 *     `runtimeEmittable=false` on every verification-gated row.
 *   - Surfacing the verified `applySemantics: "next-turn"` so the apply
 *     service refuses to attempt live application — Codex always stages until
 *     the next turn at the earliest.
 *
 * Per-cascade failure isolation mirrors the Claude translator: an undefined
 * view (cascade discovery failed upstream) is silently skipped — the composer
 * decides whether to fall back to native defaults — and never poisons the
 * other cascade.
 *
 * When SDK key verification eventually lands for either cascade, this module
 * (not its callers) must change to emit the verified config payload. Callers
 * see the same shape regardless.
 */

import {
  translateCodexCapabilities,
  type CodexCapabilityTranslationDiagnostic,
  type CodexResolvedSkill,
} from "./codex-translator";

import type {
  AgentCapabilityDiagnostic,
  AgentCapabilitySourceRef,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

export interface CodexRuntimeTranslationInput {
  skillsView: AgentCapabilityViewResponse | undefined;
  pluginsView: AgentCapabilityViewResponse | undefined;
}

export interface CodexRuntimeCapabilityConfig {
  /** Pass-through object merged into `CodexOptions.config` at next-turn
   * start. Empty until SDK key verification lands; see `codex-translator.ts`
   * for the verification-gate rationale. */
  config: Record<string, never>;
}

export interface CodexCascadeEmission {
  cascadeKind: "codex-skills" | "codex-plugins";
  /**
   * Rows that contributed to the emitted payload for this cascade. Identical
   * shape to `ClaudeCascadeEmission.emittedRows` so the composer can hash and
   * seed runtime state without branching on backend. For verification-gated
   * cascades the array is empty because no row is `runtimeEmittable`.
   */
  emittedRows: readonly { itemId: string; enabled: boolean }[];
}

export interface CodexRuntimeTranslationResult {
  config: CodexRuntimeCapabilityConfig["config"];
  diagnostics: readonly AgentCapabilityDiagnostic[];
  emissions: readonly CodexCascadeEmission[];
  /** Confirms the translator never claims live application. The apply
   * service uses this to refuse mid-conversation apply attempts. */
  applySemantics: "next-turn";
}

export function translateCodexRuntimeCapabilities(
  input: CodexRuntimeTranslationInput,
): CodexRuntimeTranslationResult {
  const skillsCascade = collectSkills(input.skillsView);
  const pluginsCascade = collectPlugins(input.pluginsView);

  const underlying = translateCodexCapabilities({
    skills: skillsCascade?.skills ?? [],
    pluginCascadeRequested: pluginsCascade !== undefined,
    pluginItemCount: pluginsCascade?.itemCount ?? 0,
  });

  const diagnostics: AgentCapabilityDiagnostic[] = underlying.diagnostics.map(
    (diag) => liftDiagnostic(diag),
  );

  const emissions: CodexCascadeEmission[] = [];
  if (skillsCascade) {
    emissions.push({
      cascadeKind: "codex-skills",
      emittedRows: skillsCascade.emittedRows,
    });
  }
  if (pluginsCascade) {
    emissions.push({
      cascadeKind: "codex-plugins",
      emittedRows: pluginsCascade.emittedRows,
    });
  }

  return {
    config: underlying.config,
    diagnostics,
    emissions,
    applySemantics: underlying.applySemantics,
  };
}

interface SkillsCascadeProjection {
  skills: readonly CodexResolvedSkill[];
  emittedRows: readonly { itemId: string; enabled: boolean }[];
}

function collectSkills(
  view: AgentCapabilityViewResponse | undefined,
): SkillsCascadeProjection | undefined {
  if (!view) return undefined;
  const skills: CodexResolvedSkill[] = [];
  const emittedRows: { itemId: string; enabled: boolean }[] = [];

  for (const row of view.items) {
    // The underlying translator only needs the rows that *would* be emitted
    // if a verified key existed. Stale/unavailable rows are skipped so the
    // diagnostic surface stays focused on what the cascade actually owns.
    if (row.runtimeEmittable) {
      emittedRows.push({
        itemId: row.itemId,
        enabled: row.effectiveState.enabled,
      });
    }
    // The underlying `pluginItemCount`/`skills` checks should see every row
    // discovered by the cascade — including verification-gated ones — so the
    // diagnostic fires whenever the user has any Codex skill installed. Build
    // a parallel projection regardless of `runtimeEmittable` so the gated
    // diagnostic still fires.
    if (!row.stale) {
      skills.push({
        itemId: row.itemId,
        enabled: row.effectiveState.enabled,
        sourcePath: sourceRefPath(row.source),
      });
    }
  }

  return { skills, emittedRows };
}

interface PluginsCascadeProjection {
  itemCount: number;
  emittedRows: readonly { itemId: string; enabled: boolean }[];
}

function collectPlugins(
  view: AgentCapabilityViewResponse | undefined,
): PluginsCascadeProjection | undefined {
  if (!view) return undefined;
  const emittedRows: { itemId: string; enabled: boolean }[] = [];
  let itemCount = 0;
  for (const row of view.items) {
    if (row.runtimeEmittable) {
      emittedRows.push({
        itemId: row.itemId,
        enabled: row.effectiveState.enabled,
      });
    }
    if (!row.stale) {
      itemCount += 1;
    }
  }
  return { itemCount, emittedRows };
}

function sourceRefPath(source: AgentCapabilitySourceRef): string {
  switch (source.kind) {
    case "global-file":
    case "project-file":
    case "user-file":
    case "system-file":
      return source.path;
    case "plugin":
    case "sdk-runtime":
      return "";
  }
}

function liftDiagnostic(
  diag: CodexCapabilityTranslationDiagnostic,
): AgentCapabilityDiagnostic {
  return {
    severity: diag.severity,
    code: diag.code,
    message: diag.message,
    cascadeKind: diag.cascadeKind,
    backend: "codex",
  };
}
