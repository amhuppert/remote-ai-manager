import { z } from "zod";

import {
  DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES,
  type DeliveryPlanBindingLintIssueCode,
} from "./delivery-plan-binding-lint";
import {
  DELIVERY_PLAN_GATE_RULE_IDS,
  LAUNCH_ADVISORY_RULE_ID,
  LAUNCH_CHARTER_UNAUTHORED_RULE_ID,
  LAUNCH_NOT_ADMISSIBLE_RULE_ID,
  PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID,
  PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID,
} from "./delivery-plan-health";
import { EVERGREEN_LINT_RULES } from "./lint";

const lintRuleDefinitionSchema = z.object({
  ruleId: z.string().min(1),
  severity: z.enum(["blocks_propose", "blocks_signoff", "advisory"]),
  /**
   * What the severity alone would mislead a reader about. The two reaffirmation
   * codes block propose but no agent write clears them, so an agent that reads
   * only the transition would keep re-authoring against a human act.
   */
  note: z.string().min(1).optional(),
});

export const nativeSddGuidanceSchema = z.object({
  lintTaxonomy: z.object({
    evergreen: z.array(lintRuleDefinitionSchema),
    deliveryPlan: z.array(lintRuleDefinitionSchema),
  }),
});

export type NativeSddGuidance = z.infer<typeof nativeSddGuidanceSchema>;

/**
 * The two binding codes an agent write can never clear: the reaffirmation of a
 * criterion an earlier execution delivered is a human judgment, so an agent
 * that read only the transition would re-author against a wall.
 */
const HUMAN_ACT_BINDING_CODES: ReadonlySet<DeliveryPlanBindingLintIssueCode> =
  new Set<DeliveryPlanBindingLintIssueCode>([
    "binding/pending-reaffirmation",
    "binding/reaffirmed-without-delivery",
  ]);

/**
 * The delivery-plan gate's rules, derived from the two arrays the gate itself
 * types its findings against: the binding lint's code list and the launch,
 * charter and readability ids. Publishing a code the gate can emit is therefore
 * not a step anyone can forget — a new rule fails to compile until it is in one
 * of those arrays, and being in one puts it here.
 */
const GATE_RULE_SEVERITY: Record<
  (typeof DELIVERY_PLAN_GATE_RULE_IDS)[number],
  z.infer<typeof lintRuleDefinitionSchema>["severity"]
> = {
  "plan/coverage-upgrade-required": "blocks_propose",
  [LAUNCH_NOT_ADMISSIBLE_RULE_ID]: "blocks_propose",
  [LAUNCH_ADVISORY_RULE_ID]: "advisory",
  [LAUNCH_CHARTER_UNAUTHORED_RULE_ID]: "blocks_propose",
  [PLAN_PINNED_REVISION_UNAVAILABLE_RULE_ID]: "blocks_propose",
  [PLAN_WORKFLOW_DEFINITION_UNAVAILABLE_RULE_ID]: "blocks_propose",
};

const DELIVERY_PLAN_LINT_RULES = [
  ...DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES.map((ruleId) => ({
    ruleId,
    severity: "blocks_propose",
    ...(HUMAN_ACT_BINDING_CODES.has(ruleId) ? { note: "human act" } : {}),
  })),
  ...DELIVERY_PLAN_GATE_RULE_IDS.map((ruleId) => ({
    ruleId,
    severity: GATE_RULE_SEVERITY[ruleId],
  })),
];

export const NATIVE_SDD_GUIDANCE: NativeSddGuidance =
  nativeSddGuidanceSchema.parse({
    lintTaxonomy: {
      evergreen: EVERGREEN_LINT_RULES,
      deliveryPlan: DELIVERY_PLAN_LINT_RULES,
    },
  });

export interface NativeSddGuidanceSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export const NATIVE_SDD_GUIDANCE_SECTIONS = {
  evergreenLint: {
    title: "Evergreen lint taxonomy",
    lines: NATIVE_SDD_GUIDANCE.lintTaxonomy.evergreen.map(
      ({ ruleId, severity }) => `${ruleId} — ${severity}`,
    ),
  },
  deliveryPlanLint: {
    title: "Delivery-plan lint taxonomy",
    lines: NATIVE_SDD_GUIDANCE.lintTaxonomy.deliveryPlan.map(
      ({ ruleId, severity, note }) =>
        `${ruleId} — ${severity}${note === undefined ? "" : ` (${note})`}`,
    ),
  },
} as const satisfies Record<string, NativeSddGuidanceSection>;
