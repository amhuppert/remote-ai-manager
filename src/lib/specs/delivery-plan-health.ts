import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  lintDeliveryPlanBinding,
  type DeliveryPlanBindingLintIssue,
  type DeliveryPlanBindingLintIssueCode,
} from "./delivery-plan-binding-lint";
import type { DeliveryPlanUnresolvedView } from "./delivery-plan-views";
import type { LintFinding } from "./lint";
import { elementHandleInSnapshot } from "./review-state";
import type { SpecRevisionSnapshot } from "./schemas";

/**
 * The one reading of what an authored delivery-plan draft still owes. `plan
 * status`, a mutation receipt, Spec Studio's lifecycle panel, and the propose
 * refusal all render this projection, so a status that reports nothing blocking
 * and a propose that refuses cannot coexist.
 *
 * Both refusal surfaces come out of the same pass: `findings` is the
 * handle-addressed reading a human reads, `refusalConditions` the
 * path-addressed reading the authoring agent corrects its file by.
 */
export interface DeliveryPlanDraftHealth {
  readonly findings: readonly LintFinding[];
  readonly unresolved: readonly DeliveryPlanUnresolvedView[];
  readonly refusalConditions: readonly string[];
}

export interface DeliveryPlanDraftHealthInput {
  readonly pinnedRevision: SpecRevisionSnapshot;
  readonly binding: DeliveryPlanBinding;
  readonly admission: AuthoredWorkflowLaunchAdmissionResult;
}

/** The rule id a refused graph launch reports under. */
export const LAUNCH_NOT_ADMISSIBLE_RULE_ID = "launch/not-admissible";

/**
 * The rule id an admitted launch's graph advisories report under.
 *
 * The shared admission service answers with both halves — `issues` refuse,
 * `warnings` do not — and the ordinary `workflow validate` surface prints both.
 * Reading only the refusing half here would make the same launch bytes read
 * clean through a spec proposal and warned through an ordinary validate, which
 * is the dialect divergence the one-graph-dialect boundary exists to prevent.
 * The advisory is forwarded verbatim rather than re-derived: the graph owns the
 * finding, this projection only carries it.
 */
export const LAUNCH_ADVISORY_RULE_ID = "launch/advisory";

/**
 * The act each criterion-owed finding names. A code absent here refuses
 * proposal but owes no per-criterion act — a duplicate or unknown id is a
 * document repair, not an outstanding disposition.
 */
const UNRESOLVED_RESOLUTION: Partial<
  Record<DeliveryPlanBindingLintIssueCode, string>
> = {
  "binding/selected-criterion-unclaimed":
    "Claim it from a stable authored accountability context, or defer, waive, or attribute it in the binding.",
  "binding/selected-criterion-not-must-run":
    "Claim it from a context the graph runs on every path, or make its claimant unavoidable.",
  "binding/pending-reaffirmation":
    "Reaffirm it in Spec Studio, or select it for re-delivery in this plan.",
  "binding/reaffirmed-without-delivery":
    "Name the earlier execution whose delivery this reaffirmation stands on.",
};

export function projectDeliveryPlanDraftHealth(
  input: DeliveryPlanDraftHealthInput,
): DeliveryPlanDraftHealth {
  if (!input.admission.ok) {
    return {
      findings: input.admission.issues.map((issue) => ({
        ruleId: LAUNCH_NOT_ADMISSIBLE_RULE_ID,
        severity: "blocks_propose",
        elementHandle: issue.path,
        message: issue.message,
      })),
      unresolved: [],
      refusalConditions: input.admission.issues.map(
        (issue) => `${issue.path}: ${issue.message}`,
      ),
    };
  }

  const issues = lintDeliveryPlanBinding({
    pinnedRevision: input.pinnedRevision,
    binding: input.binding,
    admission: input.admission,
  });
  const dispositions = new Map(
    input.binding.dispositions.map((entry) => [
      entry.criterionElementId,
      entry,
    ]),
  );

  return {
    findings: [
      ...issues.map((issue) => ({
        ruleId: issue.code,
        severity: "blocks_propose" as const,
        elementHandle: handleFor(input.pinnedRevision, issue),
        message: issue.message,
      })),
      ...input.admission.warnings.map((warning) => ({
        ruleId: LAUNCH_ADVISORY_RULE_ID,
        severity: "advisory" as const,
        elementHandle: warning.path,
        message: warning.message,
      })),
    ],
    unresolved: unresolvedRows(input.pinnedRevision, issues, dispositions),
    refusalConditions: issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    ),
  };
}

function handleFor(
  pinnedRevision: SpecRevisionSnapshot,
  issue: DeliveryPlanBindingLintIssue,
): string {
  if (issue.criterionElementId === null) return issue.path.join(".");
  return (
    elementHandleInSnapshot(pinnedRevision, issue.criterionElementId) ??
    issue.criterionElementId
  );
}

/**
 * One row per criterion, not per finding: a criterion that is both unclaimed
 * and outside the must-run set owes one act, and the first finding names it.
 */
function unresolvedRows(
  pinnedRevision: SpecRevisionSnapshot,
  issues: readonly DeliveryPlanBindingLintIssue[],
  dispositions: ReadonlyMap<
    string,
    DeliveryPlanBinding["dispositions"][number]
  >,
): DeliveryPlanUnresolvedView[] {
  const rows: DeliveryPlanUnresolvedView[] = [];
  const named = new Set<string>();
  for (const issue of issues) {
    const criterionElementId = issue.criterionElementId;
    const resolution = UNRESOLVED_RESOLUTION[issue.code];
    if (criterionElementId === null || resolution === undefined) continue;
    if (named.has(criterionElementId)) continue;
    const disposition = dispositions.get(criterionElementId);
    if (disposition === undefined) continue;
    named.add(criterionElementId);
    rows.push({
      criterionElementId,
      handle:
        elementHandleInSnapshot(pinnedRevision, criterionElementId) ??
        criterionElementId,
      disposition: disposition.disposition,
      resolution,
    });
  }
  return rows;
}
