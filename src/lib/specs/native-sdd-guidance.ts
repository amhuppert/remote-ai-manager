import { z } from "zod";
import { EVERGREEN_LINT_RULES } from "./lint-rules";

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
  }),
});

export type NativeSddGuidance = z.infer<typeof nativeSddGuidanceSchema>;

export const NATIVE_SDD_GUIDANCE: NativeSddGuidance =
  nativeSddGuidanceSchema.parse({
    lintTaxonomy: {
      evergreen: EVERGREEN_LINT_RULES,
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
} as const satisfies Record<string, NativeSddGuidanceSection>;
