import {
  diffRevisions,
  type RevisionCitationDiffContext,
  type RevisionElement as DiffRevisionElement,
} from "./revision-diff";
import type {
  SectionRole,
  SpecAuthoringStage,
  SpecElementKind,
  SpecGate,
} from "./schemas";

export type AuthoringGate = Extract<
  SpecGate,
  "requirements" | "design" | "plan"
>;

export const authoringStages: readonly SpecAuthoringStage[] = [
  "requirements",
  "design",
  "plan",
];

export const activeAuthoringStages: readonly SpecAuthoringStage[] = [
  "requirements",
  "design",
];

export function authoringStageIndex(stage: SpecAuthoringStage): number {
  return authoringStages.indexOf(stage);
}

export function authoringStageForElement(
  kind: SpecElementKind,
  sectionRole?: SectionRole,
): SpecAuthoringStage {
  if (kind === "task") return "plan";
  if (kind === "decision") return "design";
  if (kind === "section" && sectionRole === "design_narrative") {
    return "design";
  }
  return "requirements";
}

export function nextAuthoringStage(
  stage: SpecAuthoringStage,
): SpecAuthoringStage | null {
  const index = activeAuthoringStages.indexOf(stage);
  if (index === -1) return null;
  return activeAuthoringStages[index + 1] ?? null;
}

/**
 * The gates a transition on this revision consults: the current authoring
 * stage, plus every earlier stage whose content differs from the GOVERNANCE
 * baseline — the nearest approved ancestor.
 *
 * The governance baseline rather than the immediate parent is what makes the
 * set cumulative. A change that entered through an attempt a human withdrew is
 * unchanged against that attempt, so an immediate-parent comparison drops the
 * gate and the follow-up revision inherits an admission it never earned.
 */
export function consultedAuthoringGates(
  stage: SpecAuthoringStage,
  governanceBaseRows: DiffRevisionElement[],
  revisionRows: DiffRevisionElement[],
  citations: RevisionCitationDiffContext,
): AuthoringGate[] {
  const diff = diffRevisions(governanceBaseRows, revisionRows, citations);
  const baseById = new Map(
    governanceBaseRows.map((row) => [row.elementId, row]),
  );
  const revisionById = new Map(revisionRows.map((row) => [row.elementId, row]));
  const consulted = new Set<AuthoringGate>([stage]);
  const currentStageIndex = authoringStageIndex(stage);

  for (const classification of diff.classifications) {
    if (classification.classification === "unchanged") continue;
    // Reclassifying a section changes both stages: its old role must not
    // disappear from governance just because the new role belongs here.
    const rows = [
      baseById.get(classification.elementId),
      revisionById.get(classification.elementId),
    ];
    for (const row of rows) {
      if (row === undefined) continue;
      const elementStage = authoringStageForElement(
        row.payload.kind,
        row.payload.kind === "section" ? row.payload.role : undefined,
      );
      if (authoringStageIndex(elementStage) < currentStageIndex) {
        consulted.add(elementStage);
      }
    }
  }

  return authoringStages.filter((candidate) => consulted.has(candidate));
}
