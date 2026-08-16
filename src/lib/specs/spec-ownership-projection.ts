import type { GraphRolePromptProjection } from "@/lib/workflow-graph/prompt-composer";

import {
  specExecutionBindingSnapshotV2Schema,
  type SpecExecutionBindingSnapshotV2,
} from "./execution-binding";
import type { SpecRevisionSnapshot, ValidationStrategy } from "./schemas";

const MAX_BRIEF_LENGTH = 240;
const MAX_GUIDANCE_NOTE_LENGTH = 240;

export interface SpecOwnershipProjection extends GraphRolePromptProjection {
  candidateId: string;
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`").replaceAll("|", "\\|").replaceAll("\n", " ")}\``;
}

function boundedText(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}…`;
}

function validationGuidance(strategy: ValidationStrategy): string {
  const kinds = strategy.kinds.map(inlineCode).join(", ");
  const note =
    strategy.note === undefined
      ? ""
      : ` — ${boundedText(strategy.note, MAX_GUIDANCE_NOTE_LENGTH)}`;
  return `Pinned validation guidance only (not an evidence checklist): ${kinds}${note}`;
}

/**
 * Projects the immutable binding through its pinned revision. No graph runtime
 * state participates, so every lane and the seeded document render the same
 * candidate-specific bytes even after live graph edits.
 */
export function buildSpecOwnershipProjection(
  inputBinding: SpecExecutionBindingSnapshotV2,
  snapshot: SpecRevisionSnapshot,
): SpecOwnershipProjection {
  const binding = specExecutionBindingSnapshotV2Schema.parse(inputBinding);
  if (snapshot.revision.id !== binding.pinnedRevisionId) {
    throw new Error(
      `Spec ownership projection expected pinned revision ${binding.pinnedRevisionId}, received ${snapshot.revision.id}`,
    );
  }

  const criteria = new Map(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [
            [
              element.id,
              {
                brief: version.payload.text,
                validationStrategy: version.payload.validationStrategy,
              },
            ] as const,
          ]
        : [],
    ),
  );
  const claimantsByCriterion = new Map<string, string[]>();
  for (const claim of binding.claims) {
    for (const criterionElementId of claim.criterionElementIds) {
      const claimants = claimantsByCriterion.get(criterionElementId) ?? [];
      if (!claimants.includes(claim.contextId)) {
        claimants.push(claim.contextId);
      }
      claimantsByCriterion.set(criterionElementId, claimants);
    }
  }

  const rows = binding.dispositions.map((disposition) => {
    const criterion = criteria.get(disposition.criterionElementId);
    if (criterion === undefined) {
      throw new Error(
        `Spec ownership projection cannot find criterion ${disposition.criterionElementId} in pinned revision ${binding.pinnedRevisionId}`,
      );
    }
    const claimants =
      claimantsByCriterion.get(disposition.criterionElementId) ?? [];
    return `| ${inlineCode(disposition.criterionElementId)} | ${boundedText(criterion.brief, MAX_BRIEF_LENGTH)} | ${inlineCode(disposition.disposition)} | ${disposition.deliveredByExecutionId === null ? "—" : inlineCode(disposition.deliveredByExecutionId)} | ${claimants.length === 0 ? "—" : claimants.map(inlineCode).join(", ")} | ${validationGuidance(criterion.validationStrategy)} |`;
  });

  return {
    heading: "Spec ownership",
    candidateId: binding.candidateId,
    body: [
      `- Candidate: ${inlineCode(binding.candidateId)}`,
      `- Candidate hash: ${inlineCode(binding.candidateHash)}`,
      `- Pinned revision: ${inlineCode(binding.pinnedRevisionId)}`,
      "",
      "This immutable binding is the authority for criterion ownership. A claimant is accountable for delivery; it need not perform every implementation step itself.",
      "",
      "| Criterion id | Brief guidance | Disposition | Delivered by execution | Claimant context ids | Validation guidance |",
      "| --- | --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n"),
  };
}
