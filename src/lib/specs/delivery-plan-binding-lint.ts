import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import type { AuthoredAccountabilityCoverageGroup } from "@/lib/workflow-graph/spec-bridge";

import type { DeliveryPlanBinding } from "./delivery-plan";
import type { SpecRevisionSnapshot } from "./schemas";

/**
 * Every code this lint can emit, as a value rather than a union alone: the
 * published taxonomy derives its rows from this list, so a code that cannot be
 * added without appearing here cannot be emitted unpublished.
 */
export const DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES = [
  "binding/disposition-missing",
  "binding/disposition-duplicate",
  "binding/disposition-criterion-unknown",
  "binding/selected-criterion-unclaimed",
  "binding/selected-criterion-not-must-run",
  "binding/claim-context-duplicate",
  "binding/claim-context-unstable",
  "binding/claim-criterion-duplicate",
  "binding/claim-criterion-unknown",
  "binding/claim-criterion-unselected",
  "binding/pending-reaffirmation",
  "binding/reaffirmed-without-delivery",
] as const;

export type DeliveryPlanBindingLintIssueCode =
  (typeof DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES)[number];

export interface DeliveryPlanBindingLintIssue {
  readonly code: DeliveryPlanBindingLintIssueCode;
  readonly path: readonly (string | number)[];
  readonly message: string;
  /**
   * The criterion the issue is about, or null when it is about the document
   * shape rather than one criterion. Surfaces that address a reader by handle
   * resolve it from here rather than parsing it back out of `path`.
   */
  readonly criterionElementId: string | null;
}

export interface DeliveryPlanBindingLintInput {
  readonly pinnedRevision: SpecRevisionSnapshot;
  readonly binding: DeliveryPlanBinding;
  readonly admission: Extract<
    AuthoredWorkflowLaunchAdmissionResult,
    { ok: true }
  >;
}

export function deliveryPlanBindingAccountabilityGroups(
  binding: DeliveryPlanBinding,
): AuthoredAccountabilityCoverageGroup[] {
  return binding.dispositions.flatMap((disposition) =>
    disposition.disposition !== "in_scope"
      ? []
      : [
          {
            bindingKey: disposition.criterionElementId,
            claimantContextIds: binding.claims.flatMap((claim) =>
              claim.criterionElementIds.includes(disposition.criterionElementId)
                ? [claim.contextId]
                : [],
            ),
          },
        ],
  );
}

export function lintDeliveryPlanBinding(
  input: DeliveryPlanBindingLintInput,
): DeliveryPlanBindingLintIssue[] {
  const issues: DeliveryPlanBindingLintIssue[] = [];
  const criterionIds = new Set(
    input.pinnedRevision.elements.flatMap(({ element, version }) =>
      version.payload.kind === "criterion" ? [element.id] : [],
    ),
  );
  const dispositionCounts = new Map<string, number>();
  const selectedCriterionIds = new Set<string>();

  input.binding.dispositions.forEach((disposition, index) => {
    const criterionId = disposition.criterionElementId;
    dispositionCounts.set(
      criterionId,
      (dispositionCounts.get(criterionId) ?? 0) + 1,
    );
    if (!criterionIds.has(criterionId)) {
      issues.push({
        code: "binding/disposition-criterion-unknown",
        path: ["dispositions", index, "criterionElementId"],
        criterionElementId: criterionId,
        message: `Disposition names criterion ${JSON.stringify(criterionId)}, which is absent from the pinned revision.`,
      });
    }
    if ((dispositionCounts.get(criterionId) ?? 0) > 1) {
      issues.push({
        code: "binding/disposition-duplicate",
        path: ["dispositions", index, "criterionElementId"],
        criterionElementId: criterionId,
        message: `Criterion ${JSON.stringify(criterionId)} has more than one disposition.`,
      });
    }
    if (
      criterionIds.has(criterionId) &&
      disposition.disposition === "in_scope"
    ) {
      selectedCriterionIds.add(criterionId);
    }
    if (disposition.disposition === "pending_reaffirmation") {
      issues.push({
        code: "binding/pending-reaffirmation",
        path: ["dispositions", index, "disposition"],
        criterionElementId: criterionId,
        message: `Criterion ${JSON.stringify(criterionId)} needs human reaffirmation or in-scope delivery before proposal.`,
      });
    }
    if (
      disposition.disposition === "reaffirmed" &&
      disposition.deliveredByExecutionId === null
    ) {
      issues.push({
        code: "binding/reaffirmed-without-delivery",
        path: ["dispositions", index, "deliveredByExecutionId"],
        criterionElementId: criterionId,
        message: `Reaffirmed criterion ${JSON.stringify(criterionId)} must name the earlier delivery it reaffirms.`,
      });
    }
  });

  for (const criterionId of criterionIds) {
    if ((dispositionCounts.get(criterionId) ?? 0) === 0) {
      issues.push({
        code: "binding/disposition-missing",
        path: ["dispositions"],
        criterionElementId: criterionId,
        message: `Criterion ${JSON.stringify(criterionId)} has no disposition.`,
      });
    }
  }

  const stableSourceIds = new Set(
    input.admission.stableAccountabilityContextIds,
  );
  const claimedContextIds = new Set<string>();
  const claimedSelectedCriterionIds = new Set<string>();
  input.binding.claims.forEach((claim, claimIndex) => {
    if (claimedContextIds.has(claim.contextId)) {
      issues.push({
        code: "binding/claim-context-duplicate",
        path: ["claims", claimIndex, "contextId"],
        criterionElementId: null,
        message: `Context ${JSON.stringify(claim.contextId)} has more than one claim record.`,
      });
    }
    claimedContextIds.add(claim.contextId);
    if (!stableSourceIds.has(claim.contextId)) {
      issues.push({
        code: "binding/claim-context-unstable",
        path: ["claims", claimIndex, "contextId"],
        criterionElementId: null,
        message: `Context ${JSON.stringify(claim.contextId)} is not a graph-declared stable authored accountability source.`,
      });
    }

    const claimCriterionIds = new Set<string>();
    claim.criterionElementIds.forEach((criterionId, criterionIndex) => {
      if (claimCriterionIds.has(criterionId)) {
        issues.push({
          code: "binding/claim-criterion-duplicate",
          path: ["claims", claimIndex, "criterionElementIds", criterionIndex],
          criterionElementId: criterionId,
          message: `Claim record for ${JSON.stringify(claim.contextId)} repeats criterion ${JSON.stringify(criterionId)}.`,
        });
      }
      claimCriterionIds.add(criterionId);

      if (!criterionIds.has(criterionId)) {
        issues.push({
          code: "binding/claim-criterion-unknown",
          path: ["claims", claimIndex, "criterionElementIds", criterionIndex],
          criterionElementId: criterionId,
          message: `Claim names criterion ${JSON.stringify(criterionId)}, which is absent from the pinned revision.`,
        });
        return;
      }
      if (!selectedCriterionIds.has(criterionId)) {
        issues.push({
          code: "binding/claim-criterion-unselected",
          path: ["claims", claimIndex, "criterionElementIds", criterionIndex],
          criterionElementId: criterionId,
          message: `Claim names criterion ${JSON.stringify(criterionId)}, which is not selected for this attempt.`,
        });
        return;
      }
      claimedSelectedCriterionIds.add(criterionId);
    });
  });

  for (const criterionId of selectedCriterionIds) {
    if (!claimedSelectedCriterionIds.has(criterionId)) {
      issues.push({
        code: "binding/selected-criterion-unclaimed",
        path: ["claims"],
        criterionElementId: criterionId,
        message: `Selected criterion ${JSON.stringify(criterionId)} has no claimant.`,
      });
    }
    const covered = input.admission.accountabilityGroupAnalysis.some(
      (analysis) => analysis.bindingKey === criterionId && analysis.covered,
    );
    if (!covered) {
      issues.push({
        code: "binding/selected-criterion-not-must-run",
        path: ["claims"],
        criterionElementId: criterionId,
        message: `Selected criterion ${JSON.stringify(criterionId)} has no claimant in the graph-owned conservative must-run set.`,
      });
    }
  }

  return issues;
}
