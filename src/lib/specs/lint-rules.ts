export type LintSeverity = "blocks_propose" | "blocks_signoff" | "advisory";

export interface EvergreenLintRuleDefinition {
  readonly ruleId: string;
  readonly severity: LintSeverity;
}

export const EVERGREEN_LINT_RULES = [
  { ruleId: "9.2.empty-spec", severity: "blocks_propose" },
  { ruleId: "9.3.uncovered-criterion", severity: "blocks_propose" },
  { ruleId: "9.3.task-without-criterion", severity: "blocks_propose" },
  { ruleId: "9.4.untraced-task", severity: "blocks_propose" },
  { ruleId: "9.5.dependency-cycle", severity: "blocks_propose" },
  { ruleId: "9.5.removed-task-dependency", severity: "blocks_propose" },
  { ruleId: "9.6.dangling-handle", severity: "blocks_propose" },
  { ruleId: "9.8.rejected-cited-assumption", severity: "blocks_signoff" },
  { ruleId: "9.9.approval-freshness", severity: "advisory" },
  { ruleId: "9.9.cited-element-change", severity: "advisory" },
  { ruleId: "9.9.open-question", severity: "advisory" },
  { ruleId: "9.9.materialized-task-change", severity: "advisory" },
  {
    ruleId: "9.13.design-stage-without-design-content",
    severity: "advisory",
  },
] as const satisfies readonly EvergreenLintRuleDefinition[];

export type EvergreenLintRuleId =
  (typeof EVERGREEN_LINT_RULES)[number]["ruleId"];

/**
 * Every code this lint can emit, as a value rather than a union alone: the
 * published taxonomy derives its rows from this list, so a code that cannot be
 * added without appearing here cannot be emitted unpublished.
 */
export const DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES = [
  "binding/disposition-missing",
  "binding/disposition-duplicate",
  "binding/disposition-criterion-unknown",
  "coverage/selected-criterion-uncovered",
  "coverage/not-must-run",
  "coverage/unstable-context",
  "coverage/unknown-id",
  "coverage/unselected",
  "binding/pending-reaffirmation",
  "binding/reaffirmed-without-delivery",
] as const;

export type DeliveryPlanBindingLintIssueCode =
  (typeof DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES)[number];

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
  "plan/coverage-upgrade-required",
  LAUNCH_NOT_ADMISSIBLE_RULE_ID,
  LAUNCH_ADVISORY_RULE_ID,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
  PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
  PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
] as const;

export type DeliveryPlanGateRuleId =
  | DeliveryPlanBindingLintIssueCode
  | (typeof DELIVERY_PLAN_GATE_RULE_IDS)[number];
