import { candidateClaimsDocumentPath } from "./delivery-plan-finalization";

import type { GraphRolePromptProjection } from "@/lib/workflow-graph/prompt-composer";

import {
  specExecutionBindingSnapshotV2Schema,
  type SpecExecutionBindingSnapshotV2,
} from "./execution-binding";
import type { SpecRevisionSnapshot } from "./schemas";

const ownershipBindingSchema = specExecutionBindingSnapshotV2Schema
  .pick({
    candidateId: true,
    pinnedRevisionId: true,
    dispositions: true,
    claims: true,
  })
  .strip();
type OwnershipBinding = Pick<
  SpecExecutionBindingSnapshotV2,
  "candidateId" | "pinnedRevisionId" | "dispositions" | "claims"
>;

const MAX_BRIEF_LENGTH = 240;

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

/**
 * Projects the immutable binding through its pinned revision. No graph runtime
 * state participates, so the candidate's ownership map stays fixed even after
 * live graph edits.
 *
 * Without a reader the projection is the whole map: every disposition row and
 * a per-context index, which is what the seeded claims document renders. With
 * a reader (a lane or validator prompt for one context) it is scoped to the
 * criteria that context claims, plus a pointer to the seeded document for the
 * rest. Every prompt used to carry the whole map; in a 96-criterion, 17-context
 * run that table was most of every seed and validator prompt and told each
 * reader nothing it owned.
 */
export function buildSpecOwnershipProjection(
  inputBinding: OwnershipBinding,
  snapshot: SpecRevisionSnapshot,
  contextId?: string,
  authoredContextIds: readonly string[] = [],
): SpecOwnershipProjection {
  const binding = ownershipBindingSchema.parse(inputBinding);
  if (snapshot.revision.id !== binding.pinnedRevisionId) {
    throw new Error(
      `Spec ownership projection expected pinned revision ${binding.pinnedRevisionId}, received ${snapshot.revision.id}`,
    );
  }

  const criteria = new Map(
    snapshot.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion"
        ? [[element.id, { brief: version.payload.text }] as const]
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
    return {
      criterionElementId: disposition.criterionElementId,
      line: `| ${inlineCode(disposition.criterionElementId)} | ${boundedText(criterion.brief, MAX_BRIEF_LENGTH)} | ${inlineCode(disposition.disposition)} | ${disposition.deliveredByExecutionId === null ? "—" : inlineCode(disposition.deliveredByExecutionId)} | ${claimants.length === 0 ? "—" : claimants.map(inlineCode).join(", ")} |`,
    };
  });
  const tableHeader = [
    "| Criterion id | Brief guidance | Disposition | Delivered by execution | Claimant context ids |",
    "| --- | --- | --- | --- | --- |",
  ];

  const claimsByContext = new Map(
    binding.claims.map((claim) => [claim.contextId, claim.criterionElementIds]),
  );
  const contexts = [
    ...new Set([...authoredContextIds, ...claimsByContext.keys()]),
  ]
    .sort()
    .map((contextId) => ({
      contextId,
      criterionElementIds: claimsByContext.get(contextId) ?? [],
    }));
  const sectionAnchor = (id: string) => `context-${encodeURIComponent(id)}`;
  const reader = contexts.find((claim) => claim.contextId === contextId);
  const preamble = [
    `- Candidate: ${inlineCode(binding.candidateId)}`,
    `- Pinned revision: ${inlineCode(binding.pinnedRevisionId)}`,
    "",
  ];

  if (reader !== undefined) {
    const claimed = new Set(reader.criterionElementIds);
    const ownRows = rows.filter((row) => claimed.has(row.criterionElementId));
    return {
      heading: "Spec ownership",
      candidateId: binding.candidateId,
      body: [
        ...preamble,
        `Read your claims first: [${reader.contextId}](${candidateClaimsDocumentPath(binding.candidateId)}#${sectionAnchor(reader.contextId)}).`,
        "",
        "This immutable binding is the authority for criterion ownership. A claimant is accountable for delivery; it need not perform every implementation step itself.",
        "",
        `These are the pinned spec criteria context ${inlineCode(reader.contextId)} claims. The complete map, including every other context's claims, is the seeded claims document above; read it for cross-context ownership checks rather than expecting it here.`,
        "",
        ...(ownRows.length === 0
          ? ["No selected spec criteria are claimed by this context."]
          : [...tableHeader, ...ownRows.map((row) => row.line)]),
      ].join("\n"),
    };
  }

  return {
    heading: "Spec ownership",
    candidateId: binding.candidateId,
    body: [
      ...preamble,
      "This immutable binding is the authority for criterion ownership. A claimant is accountable for delivery; it need not perform every implementation step itself.",
      "",
      ...tableHeader,
      ...rows.map((row) => row.line),
      "",
      "## Context index",
      "",
      ...contexts.map(
        (claim) => `- [${claim.contextId}](#${sectionAnchor(claim.contextId)})`,
      ),
      ...contexts.flatMap((claim) => [
        "",
        `<a id="${sectionAnchor(claim.contextId)}"></a>`,
        "",
        `## Context ${claim.contextId}`,
        "",
        ...(claim.criterionElementIds.length === 0
          ? ["No selected spec criteria are claimed by this context."]
          : []),
        ...[...claim.criterionElementIds]
          .sort()
          .map((id) => `- ${inlineCode(id)}`),
      ]),
    ].join("\n"),
  };
}
