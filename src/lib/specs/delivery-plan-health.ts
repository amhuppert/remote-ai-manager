import type { AuthoredWorkflowLaunchAdmissionResult } from "@/lib/workflow-graph/authored-launch-admission";
import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";

import type { DeliveryPlanBinding } from "./delivery-plan";
import {
  lintDeliveryPlanBinding,
  type DeliveryPlanBindingLintIssue,
  type DeliveryPlanBindingLintIssueCode,
} from "./delivery-plan-binding-lint";
import { renderSeededDeliveryPlanMission } from "./delivery-plan-charter-seed";
import { isServerOwnedDeliveryPlanSource } from "./delivery-plan-finalization";
import type { DeliveryPlanUnresolvedView } from "./delivery-plan-views";
import type { LintFinding } from "./lint";
import {
  CHARTER_UNAUTHORED_RATIONALE,
  CRITERION_MUST_RUN_RATIONALE,
} from "./refusal-rationale";
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
  readonly findings: readonly DeliveryPlanGateFinding[];
  readonly unresolved: readonly DeliveryPlanUnresolvedView[];
  readonly refusalConditions: readonly string[];
}

export interface DeliveryPlanDraftHealthInput {
  readonly pinnedRevision: SpecRevisionSnapshot;
  readonly binding: DeliveryPlanBinding;
  readonly admission: AuthoredWorkflowLaunchAdmissionResult;
  /**
   * The managed definition's charter, typed by the graph's own schema. Native
   * SDD reads the launch document; it never restates its shape.
   */
  readonly draftCharter: WorkflowCharter;
  /** The definition the charter remedy names. */
  readonly workflowDefinitionId: string;
}

/** The rule id a refused graph launch reports under. */
export const LAUNCH_NOT_ADMISSIBLE_RULE_ID = "launch/not-admissible";

/** The rule id an unauthored charter refuses proposal under. */
export const LAUNCH_CHARTER_UNAUTHORED_RULE_ID = "launch/charter-unauthored";

/** The rule id a draft whose pinned revision cannot be read refuses under. */
export const PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID =
  "plan/pinned-revision-unavailable";

/** The rule id a draft whose managed definition is missing refuses under. */
export const PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID =
  "plan/workflow-definition-unavailable";

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
 * The gate rules that are not binding lint: launch admission, the charter
 * check, and the two readability findings the service's `healthOf` raises.
 * Listed as a value so the published taxonomy derives from it — a rule this
 * array does not carry cannot be reported, because {@link
 * DeliveryPlanGateRuleId} is what a finding's `ruleId` has to be.
 */
export const DELIVERY_PLAN_GATE_RULE_IDS = [
  LAUNCH_NOT_ADMISSIBLE_RULE_ID,
  LAUNCH_ADVISORY_RULE_ID,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
  PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
  PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
] as const;

export type DeliveryPlanGateRuleId =
  | DeliveryPlanBindingLintIssueCode
  | (typeof DELIVERY_PLAN_GATE_RULE_IDS)[number];

/** A draft-health finding, narrowed to the rules the propose gate publishes. */
export interface DeliveryPlanGateFinding extends LintFinding {
  readonly ruleId: DeliveryPlanGateRuleId;
}

/**
 * The reason a finding's rule exists, for the codes whose friction is the
 * design. The refusal that carries them renders one `why:` line built from
 * these; a code absent here is a document repair that explains itself.
 */
const ISSUE_RATIONALE: Partial<
  Record<DeliveryPlanBindingLintIssueCode, string>
> = {
  "binding/selected-criterion-not-must-run": CRITERION_MUST_RUN_RATIONALE,
};

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

/**
 * The one `why:` line a propose refusal carries: the distinct rationales of the
 * findings that refuse it. Composed here rather than at the refusal so the
 * reason a rule exists travels with the rule.
 */
export function deliveryPlanRefusalRationale(
  health: DeliveryPlanDraftHealth,
): string | undefined {
  const rationales = [
    ...new Set(
      health.findings.flatMap((finding) =>
        finding.severity === "blocks_propose" && finding.rationale !== undefined
          ? [finding.rationale]
          : [],
      ),
    ),
  ];
  return rationales.length === 0 ? undefined : rationales.join("; ");
}

export function projectDeliveryPlanDraftHealth(
  input: DeliveryPlanDraftHealthInput,
): DeliveryPlanDraftHealth {
  // The governance rule reads the charter, so it is projected whatever the
  // graph says. An inadmissible launch used to short-circuit the projection,
  // which hid the charter refusal until the graph was fixed and then raised it
  // for the first time — one correction reporting two rounds of refusals.
  const charterFindings = charterUnauthoredFindings(input);
  const charterConditions = charterFindings.map(
    (finding) => `${finding.elementHandle}: ${finding.message}`,
  );

  if (!input.admission.ok) {
    return {
      findings: [
        ...input.admission.issues.map(
          (issue): DeliveryPlanGateFinding => ({
            ruleId: LAUNCH_NOT_ADMISSIBLE_RULE_ID,
            severity: "blocks_propose",
            elementHandle: issue.path,
            message: issue.message,
          }),
        ),
        ...charterFindings,
      ],
      unresolved: [],
      refusalConditions: [
        ...input.admission.issues.map(
          (issue) => `${issue.path}: ${issue.message}`,
        ),
        ...charterConditions,
      ],
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
      ...issues.map(
        (issue): DeliveryPlanGateFinding => ({
          ruleId: issue.code,
          severity: "blocks_propose",
          elementHandle: handleFor(input.pinnedRevision, issue),
          message: issue.message,
          ...rationaleFor(issue.code),
        }),
      ),
      ...charterFindings,
      ...input.admission.warnings.map(
        (warning): DeliveryPlanGateFinding => ({
          ruleId: LAUNCH_ADVISORY_RULE_ID,
          severity: "advisory",
          elementHandle: warning.path,
          message: warning.message,
        }),
      ),
    ],
    unresolved: unresolvedRows(input.pinnedRevision, issues, dispositions),
    refusalConditions: [
      ...issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
      ...charterConditions,
    ],
  };
}

function rationaleFor(code: DeliveryPlanBindingLintIssueCode): {
  rationale?: string;
} {
  const rationale = ISSUE_RATIONALE[code];
  return rationale === undefined ? {} : { rationale };
}

/**
 * The governance rule (design 3.5). A draft whose mission is still the text the
 * server seeded, or whose charter names nothing beyond the entries the server
 * injects, has been planned but not governed — and propose is the last moment
 * anyone can say so, because the candidate freezes the charter it carries.
 *
 * Both halves report under one code and one reason, addressed at the charter
 * field that fails, so a planner correcting one is not told twice about it.
 */
function charterUnauthoredFindings(
  input: DeliveryPlanDraftHealthInput,
): DeliveryPlanGateFinding[] {
  const remedy = `store an authored charter with \`cctl workflow replace ${input.workflowDefinitionId} --file <plan.json>\``;
  const findings: DeliveryPlanGateFinding[] = [];
  const seededMission = renderSeededDeliveryPlanMission({
    pinnedRevision: input.pinnedRevision,
  });
  if (input.draftCharter.mission.trim() === seededMission.trim()) {
    findings.push({
      ruleId: LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      severity: "blocks_propose",
      elementHandle: "charter.mission",
      message: `The mission is still the text \`spec plan open\` seeded from the spec's intent; ${remedy}.`,
      rationale: CHARTER_UNAUTHORED_RATIONALE,
    });
  }
  if (
    input.draftCharter.sourcesOfTruth.every(isServerOwnedDeliveryPlanSource)
  ) {
    findings.push({
      ruleId: LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
      severity: "blocks_propose",
      elementHandle: "charter.sourcesOfTruth",
      message: `The charter cites only the sources the server injects, so it names no authority an implementer resolves a conflict against; ${remedy}.`,
      rationale: CHARTER_UNAUTHORED_RATIONALE,
    });
  }
  return findings;
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
