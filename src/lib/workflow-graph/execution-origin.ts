import type { GraphWorkflowExecutionOrigin } from "./schemas";

/** The launch source supplies the authoritative origin and any saved definition. */
export type GraphWorkflowLaunchSource =
  | {
      kind: "template";
      definitionId: string;
      definitionRevision: number;
      tier: "project" | "global";
    }
  | { kind: "one_off"; planName: string }
  | {
      kind: "spec_delivery";
      specSlug: string;
      candidateId: string;
      definitionId: string;
      definitionRevision: number;
    };

/** The definition-tier provenance fields one launch source resolves to. */
export interface GraphWorkflowExecutionProvenance {
  origin: GraphWorkflowExecutionOrigin;
  seedDefinitionId: string | null;
  seedDefinitionRevision: number | null;
  launchedTier: "project" | "global";
}

/** Resolve provenance without inventing a saved definition for an inline plan. */
export function buildExecutionProvenance(
  source: GraphWorkflowLaunchSource,
): GraphWorkflowExecutionProvenance {
  if (source.kind === "template") {
    return {
      origin: {
        kind: "template",
        definitionId: source.definitionId,
        definitionRevision: source.definitionRevision,
        tier: source.tier,
      },
      seedDefinitionId: source.definitionId,
      seedDefinitionRevision: source.definitionRevision,
      launchedTier: source.tier,
    };
  }
  if (source.kind === "spec_delivery") {
    return {
      origin: {
        kind: "spec_delivery",
        specSlug: source.specSlug,
        candidateId: source.candidateId,
      },
      seedDefinitionId: source.definitionId,
      seedDefinitionRevision: source.definitionRevision,
      launchedTier: "project",
    };
  }
  return {
    origin: { kind: "one_off", planName: source.planName },
    seedDefinitionId: null,
    seedDefinitionRevision: null,
    launchedTier: "project",
  };
}

/**
 * The structured log fields that attribute a launch without leaking the
 * absent definition: a template launch names its definition, a one-off
 * names its plan, a spec delivery names its spec and candidate. Every
 * launch-path log line spreads this instead of reading the seed projection,
 * which on a definition-less row means nothing.
 */
export function describeLaunchSource(
  source: GraphWorkflowLaunchSource | GraphWorkflowExecutionOrigin,
): Record<string, string | number> {
  if (source.kind === "template") {
    return {
      origin: "template",
      definitionId: source.definitionId,
      definitionRevision: source.definitionRevision,
      tier: source.tier,
    };
  }
  if (source.kind === "spec_delivery") {
    const attribution = {
      origin: "spec_delivery",
      specSlug: source.specSlug,
      candidateId: source.candidateId,
    };
    return "definitionId" in source
      ? {
          ...attribution,
          definitionId: source.definitionId,
          definitionRevision: source.definitionRevision,
        }
      : attribution;
  }
  return { origin: "one_off", planName: source.planName };
}

/**
 * The template origin a row written before `origin` existed implies. Pre-D7
 * runs were all template launches, and the seed fields already record which
 * definition and revision — `launchedTier` predates the global tier on the
 * oldest rows, which is why an absent tier floors to `project` exactly as the
 * field's own schema default does.
 */
export function deriveTemplateOriginFromSeedFields(seed: {
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  launchedTier: "project" | "global" | undefined;
}): Extract<GraphWorkflowExecutionOrigin, { kind: "template" }> {
  return {
    kind: "template",
    definitionId: seed.seedDefinitionId,
    definitionRevision: seed.seedDefinitionRevision,
    tier: seed.launchedTier ?? "project",
  };
}

/**
 * The human-facing name a run falls back to when it carries no launch
 * document. Exhaustive over the union so a new origin kind fails to compile
 * here rather than silently borrowing another kind's identity at each of the
 * render sites that share this fallback.
 */
export function originFallbackName(
  origin: GraphWorkflowExecutionOrigin,
): string {
  switch (origin.kind) {
    case "template":
      return origin.definitionId;
    case "one_off":
      return origin.planName;
    case "spec_delivery":
      return origin.specSlug;
  }
}

/** The badge label an origin kind renders under; exhaustive for the same reason. */
export function originKindLabel(origin: GraphWorkflowExecutionOrigin): string {
  switch (origin.kind) {
    case "template":
      return "Template";
    case "one_off":
      return "One-off";
    case "spec_delivery":
      return "Spec delivery";
  }
}

/**
 * Floor an absent `origin` on a RAW stored candidate, in place, before it is
 * parsed. Mirrors the other pre-parse repairs at the inflate boundary
 * (`normalizeRawDefinitionEdgeIds`, `migrateRawExecutionPlacement`): the field
 * is required on the domain record, so the one place absence is tolerated is
 * here, where the seed fields the floor derives from are still in hand.
 *
 * A candidate that already carries an origin is left untouched even when it
 * disagrees with the seed fields — the recorded provenance is the fact, and the
 * seed fields can be absent for an inline plan.
 *
 * ABSENT is the only shape floored. A stored `null` is not a pre-D7 row: JSON
 * has no `undefined`, so a null origin can only come from a post-D7 build that
 * failed to record provenance, and flooring it would relabel a corrupt row as a
 * template run — on a one-off row, one whose derived definition id matches no
 * definition at all. It falls through to the parse instead.
 *
 * Returns whether it repaired anything; a malformed candidate is left alone for
 * the parse to refuse with located issues.
 */
export function floorRawExecutionOrigin(candidate: unknown): boolean {
  if (typeof candidate !== "object" || candidate === null) return false;
  const record = candidate as Record<string, unknown>;
  if (record.origin !== undefined) return false;

  const seedDefinitionId = record.seedDefinitionId;
  const seedDefinitionRevision = record.seedDefinitionRevision;
  if (
    typeof seedDefinitionId !== "string" ||
    seedDefinitionId.trim() === "" ||
    typeof seedDefinitionRevision !== "number" ||
    !Number.isInteger(seedDefinitionRevision)
  ) {
    return false;
  }

  const launchedTier = record.launchedTier;
  record.origin = deriveTemplateOriginFromSeedFields({
    seedDefinitionId,
    seedDefinitionRevision,
    launchedTier:
      launchedTier === "project" || launchedTier === "global"
        ? launchedTier
        : undefined,
  });
  return true;
}
