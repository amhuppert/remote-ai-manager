import type {
  GraphWorkflowExecution,
  GraphWorkflowExecutionOrigin,
} from "./schemas";

/**
 * Origin provenance derivation for graph-workflow executions (D7 decision D2).
 *
 * Two rules live here and nowhere else: how a pre-D7 row's absent origin is
 * floored to the template origin it implies, and what legacy-shaped filler a
 * one-off row writes into the seed fields so an older build can still parse it.
 * Both are read by the persistence decode boundary, so keeping them in one pure
 * module is what stops the sentinel from being re-derived per call site — which
 * is exactly how a projection turns into an authority.
 */

/**
 * Namespace for the seed id a one-off run writes. Deliberately not a valid
 * stored-definition id: it matches no definition record, so the locked-region
 * replace guard and every seed-id comparison keep behaving correctly without
 * learning about one-off runs.
 */
export const ONE_OFF_SEED_DEFINITION_ID_PREFIX = "one-off:";

/**
 * The legacy-shaped definition-tier fields a one-off execution persists
 * alongside its `origin`.
 *
 * Every pre-D7 reader parses the definition tier with `seedDefinitionId`
 * non-empty and `seedDefinitionRevision` a positive integer, and the active
 * repository's `listActive()` decodes EVERY row in the set — so one unparseable
 * one-off row would cost an older build the workflow state of every session.
 * The filler keeps those readers whole; new readers must ignore it entirely.
 */
export function buildOneOffSeedCompatibilityFields(executionId: string): {
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  launchedTier: "project";
} {
  return {
    seedDefinitionId: `${ONE_OFF_SEED_DEFINITION_ID_PREFIX}${executionId}`,
    seedDefinitionRevision: 1,
    launchedTier: "project",
  };
}

/**
 * Where a launch's definition content came from, as decided by the launch
 * source before any seeding runs. This is the ONE input the seed carries about
 * provenance: `origin` and the legacy-shaped seed projection are both derived
 * from it below, so a caller cannot supply an origin that disagrees with the
 * filler beside it.
 */
export type GraphWorkflowLaunchSource =
  | {
      kind: "template";
      definitionId: string;
      definitionRevision: number;
      tier: "project" | "global";
    }
  | { kind: "one_off"; planName: string };

/** The definition-tier provenance fields one launch source resolves to. */
export interface GraphWorkflowExecutionProvenance {
  origin: GraphWorkflowExecutionOrigin;
  seedDefinitionId: string;
  seedDefinitionRevision: number;
  launchedTier: "project" | "global";
}

/**
 * Resolve a launch source into the provenance an execution persists: the
 * authoritative `origin` plus the legacy-shaped seed projection an older build
 * still parses (D7 decision D2).
 *
 * Pairing the two here is the point. A template run's projection IS its origin,
 * while a one-off run's projection is deliberate filler that names no stored
 * definition — deriving both from one source in one place is what keeps a
 * consumer from ever finding an origin and a projection that disagree.
 */
export function buildExecutionProvenance(
  source: GraphWorkflowLaunchSource,
  executionId: string,
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
  return {
    origin: { kind: "one_off", planName: source.planName },
    ...buildOneOffSeedCompatibilityFields(executionId),
  };
}

/**
 * The structured log fields that attribute a launch without leaking the one-off
 * filler: a template launch names its definition, a one-off names its plan.
 * Every launch-path log line spreads this instead of reading the seed
 * projection, which on a one-off row means nothing.
 */
export function describeLaunchSource(
  source: GraphWorkflowLaunchSource,
): Record<string, string | number> {
  return source.kind === "template"
    ? {
        origin: "template",
        definitionId: source.definitionId,
        definitionRevision: source.definitionRevision,
        tier: source.tier,
      }
    : { origin: "one_off", planName: source.planName };
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

/** Whether this run was launched from an inline plan rather than a template. */
export function isOneOffExecution(
  execution: Pick<GraphWorkflowExecution, "origin">,
): boolean {
  return execution.origin.kind === "one_off";
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
 * seed fields on a one-off row are deliberately filler.
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
