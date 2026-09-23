import type { DeliveryPlanBindingLintIssueCode } from "./lint-rules";
export {
  DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES,
  type DeliveryPlanBindingLintIssueCode,
} from "./lint-rules";
import {
  collectStableAccountabilityContextIds,
  criterionRecordsOf,
  type AuthoredAccountabilityCoverageGroup,
  type WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/spec-bridge";
import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";

import type { DeliveryPlanBinding, DeliveryPlanClaim } from "./delivery-plan";
import type { SpecRevisionSnapshot } from "./schemas";

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
  definition: WorkflowSemanticDefinition,
): AuthoredAccountabilityCoverageGroup[] {
  const claims = deriveDeliveryPlanClaims(binding, definition);
  return binding.dispositions.flatMap((disposition) =>
    disposition.disposition !== "in_scope"
      ? []
      : [
          {
            bindingKey: disposition.criterionElementId,
            claimantContextIds: claims.flatMap((claim) =>
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
  const coveredSelectedIds = new Set<string>();
  const recordsByCriterion = new Map<string, string[]>();
  input.admission.launch.definition.executionContexts.forEach(
    (context, contextIndex) => {
      criterionRecordsOf(context.acceptanceCriteria).forEach(
        (record, recordIndex) => {
          (record.covers ?? []).forEach((criterionId, coverageIndex) => {
            const path = [
              "definition",
              "executionContexts",
              contextIndex,
              "acceptanceCriteria",
              recordIndex,
              "covers",
              coverageIndex,
            ];
            const locatedRecord = `${context.id}/${record.id}`;
            const common = { path, criterionElementId: criterionId };
            const stable = stableSourceIds.has(context.id);
            if (!stable) {
              issues.push({
                ...common,
                code: "coverage/unstable-context",
                message: `Covering record ${locatedRecord} is not in a stable authored accountability context; move its covers entry to the stable authored ancestor.`,
              });
            }
            if (!criterionIds.has(criterionId)) {
              issues.push({
                ...common,
                code: "coverage/unknown-id",
                message: `Record ${locatedRecord} covers ${JSON.stringify(criterionId)}, which is absent from the pinned revision; correct or remove this covers entry.`,
              });
              return;
            }
            if (!selectedCriterionIds.has(criterionId)) {
              issues.push({
                ...common,
                code: "coverage/unselected",
                message: `Record ${locatedRecord} covers ${JSON.stringify(criterionId)}, which is not selected; remove its covers entry or change the disposition in Spec Studio.`,
              });
              return;
            }
            recordsByCriterion.set(criterionId, [
              ...(recordsByCriterion.get(criterionId) ?? []),
              locatedRecord,
            ]);
            if (stable) coveredSelectedIds.add(criterionId);
          });
        },
      );
    },
  );

  for (const criterionId of selectedCriterionIds) {
    if (!coveredSelectedIds.has(criterionId)) {
      issues.push({
        code: "coverage/selected-criterion-uncovered",
        path: ["definition", "executionContexts"],
        criterionElementId: criterionId,
        message: `Selected criterion ${JSON.stringify(criterionId)} has no covering record in a stable authored context; add it to that record's covers and store the plan with workflow replace.`,
      });
      continue;
    }
    const covered = input.admission.accountabilityGroupAnalysis.some(
      (analysis) => analysis.bindingKey === criterionId && analysis.covered,
    );
    if (!covered) {
      issues.push({
        code: "coverage/not-must-run",
        path: ["definition", "executionContexts"],
        criterionElementId: criterionId,
        message: `Selected criterion ${JSON.stringify(criterionId)} is covered by ${(recordsByCriterion.get(criterionId) ?? []).join(", ")}, but those contexts can all be skipped. Also cover it from an always-run closeout context that verifies whichever route ran, or change its disposition in Spec Studio.`,
      });
    }
  }

  input.admission.launch.definition.executionContexts.forEach(
    (context, contextIndex) => {
      if (!stableSourceIds.has(context.id)) return;
      const records = criterionRecordsOf(context.acceptanceCriteria);
      if (records.length === 0) return;
      const coversSelected = records.some((record) =>
        (record.covers ?? []).some((criterionId) =>
          selectedCriterionIds.has(criterionId),
        ),
      );
      if (coversSelected) return;
      const noun = records.length === 1 ? "criterion" : "criteria";
      issues.push({
        code: "coverage/plan-authored-context",
        path: [
          "definition",
          "executionContexts",
          contextIndex,
          "acceptanceCriteria",
        ],
        criterionElementId: null,
        message: `Context ${context.id} owns no selected spec criterion: its ${records.length} acceptance ${noun} (${records.map((record) => record.id).join(", ")}) is plan-authored. Justify each plan-authored obligation against the design or the charter, or add covers.`,
      });
    },
  );

  return issues;
}

export function deriveDeliveryPlanClaims(
  binding: DeliveryPlanBinding,
  definition: WorkflowSemanticDefinition,
  stableContextIds: readonly string[] = collectStableAccountabilityContextIds(
    definition,
  ),
): DeliveryPlanClaim[] {
  const selected = new Set(
    binding.dispositions.flatMap((entry) =>
      entry.disposition === "in_scope" ? [entry.criterionElementId] : [],
    ),
  );
  const stable = new Set(stableContextIds);
  return definition.executionContexts.flatMap((context) => {
    if (!stable.has(context.id)) return [];
    const criterionElementIds = [
      ...new Set(
        criterionRecordsOf(context.acceptanceCriteria)
          .flatMap((record) => record.covers ?? [])
          .filter((id) => selected.has(id)),
      ),
    ];
    return criterionElementIds.length === 0
      ? []
      : [{ contextId: context.id, criterionElementIds }];
  });
}
