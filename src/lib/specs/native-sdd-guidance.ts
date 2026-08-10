import { z } from "zod";

import { DELIVERY_PLAN_LINT_RULES } from "./delivery-plan-lint";
import { DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS } from "./delivery-plan-materializer";
import { EVIDENCE_PRODUCERS } from "./evidence-producers";
import { EVERGREEN_LINT_RULES } from "./lint";

const materializerFieldMappingSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  transformation: z.string().min(1),
});

const lintRuleDefinitionSchema = z.object({
  ruleId: z.string().min(1),
  severity: z.enum([
    "blocks_propose",
    "blocks_claim",
    "blocks_signoff",
    "advisory",
  ]),
});

const evidenceProducerDefinitionSchema = z.object({
  kind: z.enum(["commit", "test_run", "validator_verdict"]),
  sourceEvent: z.enum([
    "graph-workflow-lane-commit",
    "graph-workflow-validation-result",
  ]),
  requiresStrategyDeclaration: z.boolean(),
  detail: z.string().min(1),
});

export const nativeSddGuidanceSchema = z.object({
  materializerFieldMappings: z.array(materializerFieldMappingSchema),
  lintTaxonomy: z.object({
    evergreen: z.array(lintRuleDefinitionSchema),
    deliveryPlan: z.array(lintRuleDefinitionSchema),
  }),
  evidenceProducers: z.array(evidenceProducerDefinitionSchema),
});

export type NativeSddGuidance = z.infer<typeof nativeSddGuidanceSchema>;

export const NATIVE_SDD_GUIDANCE: NativeSddGuidance =
  nativeSddGuidanceSchema.parse({
    materializerFieldMappings: DELIVERY_PLAN_MATERIALIZER_FIELD_MAPPINGS,
    lintTaxonomy: {
      evergreen: EVERGREEN_LINT_RULES,
      deliveryPlan: DELIVERY_PLAN_LINT_RULES,
    },
    evidenceProducers: EVIDENCE_PRODUCERS,
  });

export interface NativeSddGuidanceSection {
  readonly title: string;
  readonly lines: readonly string[];
}

export const NATIVE_SDD_GUIDANCE_SECTIONS = {
  materializer: {
    title: "Materializer field mappings",
    lines: NATIVE_SDD_GUIDANCE.materializerFieldMappings.map(
      ({ source, target, transformation }) =>
        `${source} -> ${target} (${transformation})`,
    ),
  },
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
  evidenceProducers: {
    title: "Evidence producers",
    lines: NATIVE_SDD_GUIDANCE.evidenceProducers.map(
      ({ kind, sourceEvent, requiresStrategyDeclaration, detail }) =>
        `${kind} <- ${sourceEvent}${requiresStrategyDeclaration ? " (requires declaring strategy)" : ""}: ${detail}`,
    ),
  },
} as const satisfies Record<string, NativeSddGuidanceSection>;
