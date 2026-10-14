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
  { ruleId: "9.14.duplicate-validation-note", severity: "advisory" },
] as const satisfies readonly EvergreenLintRuleDefinition[];

export type EvergreenLintRuleId =
  (typeof EVERGREEN_LINT_RULES)[number]["ruleId"];
