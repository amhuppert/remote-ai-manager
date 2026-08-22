import type { ConfigGranularity, ConfigScope, ConfigTier } from "./types";

/**
 * The provenance chrome vocabulary. Every row states where its value came from
 * and, when the value is the reader's own, offers to drop it back to the tier
 * above — and the offer has to name which granularity it clears, because
 * resetting one role or one field must never take its siblings with it
 * (design README §7).
 */
export interface ConfigRowProvenance {
  /** Tier the effective value resolves from. */
  sourceTier: ConfigTier;
  /** Tier the panel is editing. The execution host is always `context`. */
  scopeTier: ConfigScope;
  granularity: ConfigGranularity;
  /**
   * A drill row summarises several paths at once: it counts as set here when
   * ANY of them is, while `sourceTier` still names where the first resolves
   * from. Left unset, provenance is the plain tier comparison.
   */
  setHere?: boolean;
}

const TIER_CHIP: Record<ConfigTier, "G" | "W" | null> = {
  global: "G",
  workflow: "W",
  context: null,
};

const TIER_NAME: Record<ConfigTier, string> = {
  global: "global defaults",
  workflow: "this workflow",
  context: "this context",
};

/**
 * The provenance a row wears when it authors IDENTITY content rather than
 * cascade configuration — a title, an acceptance criterion, a lane. There is no
 * tier above such a field to inherit from, so the row shows no tier chip, no
 * cyan set-here edge and no reset: `setHere: false` against a `context` source
 * resolves every one of those to nothing.
 */
export const IDENTITY_PROVENANCE: ConfigRowProvenance = {
  sourceTier: "context",
  scopeTier: "context",
  granularity: "block",
  setHere: false,
};

export function isSetHere(provenance: ConfigRowProvenance): boolean {
  return provenance.setHere ?? provenance.sourceTier === provenance.scopeTier;
}

export function inheritedTierChip(
  provenance: ConfigRowProvenance,
): "G" | "W" | null {
  if (isSetHere(provenance)) return null;
  return TIER_CHIP[provenance.sourceTier];
}

export function inheritedTierTitle(
  provenance: ConfigRowProvenance,
): string | null {
  if (isSetHere(provenance)) return null;
  return `Inherited from ${TIER_NAME[provenance.sourceTier]} — this ${provenance.granularity} is not set on the ${provenance.scopeTier}`;
}

export function resetToInheritTitle(granularity: ConfigGranularity): string {
  return `Reset this ${granularity} to inherit`;
}
