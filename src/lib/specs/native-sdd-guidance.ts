import { z } from "zod";

import { EVERGREEN_LINT_RULES } from "./lint";

const lintRuleDefinitionSchema = z.object({
  ruleId: z.string().min(1),
  severity: z.enum(["blocks_propose", "blocks_signoff", "advisory"]),
});

export const nativeSddGuidanceSchema = z.object({
  lintTaxonomy: z.object({
    evergreen: z.array(lintRuleDefinitionSchema),
    deliveryPlan: z.array(lintRuleDefinitionSchema),
  }),
});

export type NativeSddGuidance = z.infer<typeof nativeSddGuidanceSchema>;

export const NATIVE_SDD_GUIDANCE: NativeSddGuidance =
  nativeSddGuidanceSchema.parse({
    lintTaxonomy: {
      evergreen: EVERGREEN_LINT_RULES,
      deliveryPlan: [],
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
      ({ ruleId, severity }) => `${ruleId} — ${severity}`,
    ),
  },
} as const satisfies Record<string, NativeSddGuidanceSection>;
