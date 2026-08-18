import { z } from "zod";

import { omissionSchema } from "../../disclosure";
import {
  deliveryDisplaySchema,
  specPhaseProjectionSchema,
} from "@/lib/specs/phase";
import {
  specAuthoringStageSchema,
  specRevisionStateSchema,
} from "@/lib/specs/schemas";
import {
  lintFindingSchema,
  specAssumptionElementViewSchema,
  specElementViewSchema,
  specQuestionElementViewSchema,
  specShowOutlineViewSchema,
  specStatusViewSchema,
  specSummaryViewSchema,
} from "@/lib/specs/view-schemas";

const ENVELOPE_DISCRIMINATORS = new Set(["ok", "command", "view"]);

function payloadFields(schemas: readonly z.ZodObject[]): readonly string[] {
  return [
    ...new Set(
      schemas.flatMap((schema) =>
        Object.keys(schema.shape).filter(
          (field) => !ENVELOPE_DISCRIMINATORS.has(field),
        ),
      ),
    ),
  ];
}

export const specShowIdentitySchema = z
  .object({
    id: z.string().min(1),
    slug: z.string().min(1),
    name: z.string(),
  })
  .strict();

const specShowCurrentRevisionSchema = z
  .object({
    role: z.literal("current"),
    id: z.string().min(1),
    number: z.number().int().positive(),
    state: specRevisionStateSchema,
    authoringStage: specAuthoringStageSchema,
    basedOnRevisionId: z.string().min(1).nullable(),
  })
  .strict();

export const specShowRevisionRefSchema =
  specShowCurrentRevisionSchema.nullable();

export const specShowArtifactRevisionSchema = specShowCurrentRevisionSchema
  .omit({ id: true, basedOnRevisionId: true })
  .strict()
  .nullable();

const specShowSummaryCollectionDisclosureSchema = z
  .object({
    total: z.number().int().nonnegative(),
    returned: z.literal(0),
    truncated: z.boolean(),
  })
  .strict();

const specShowSummaryDisclosureSchema = z
  .object({
    requirements: specShowSummaryCollectionDisclosureSchema,
    criteria: specShowSummaryCollectionDisclosureSchema,
    decisions: specShowSummaryCollectionDisclosureSchema,
    tasks: specShowSummaryCollectionDisclosureSchema,
    next: z.string().min(1),
  })
  .strict();

export const specShowSummaryInlineEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("spec show"),
    view: z.literal("summary"),
    storage: z.literal("inline"),
    spec: specShowIdentitySchema,
    revision: specShowRevisionRefSchema,
    phase: specPhaseProjectionSchema,
    counts: specSummaryViewSchema.shape.counts,
    pendingApprovalCount: z.number().int().nonnegative(),
    approvalState: z.enum(["complete", "pending"]),
    delivery: deliveryDisplaySchema
      .omit({ deliveredExternallyCriterionIds: true })
      .extend({
        deliveredExternallyCount: z.number().int().nonnegative(),
      })
      .strict(),
    linkedWork: specSummaryViewSchema.shape.linkedWork,
    imported: z.boolean(),
    disclosure: specShowSummaryDisclosureSchema,
  })
  .strict();

export const specShowOutlineInlineEnvelopeSchema = specShowOutlineViewSchema
  .extend({
    ok: z.literal(true),
    command: z.literal("spec show"),
    view: z.literal("outline"),
    storage: z.literal("inline"),
  })
  .strict();

export const specShowArtifactSchema = z
  .object({
    path: z.string().min(1),
    format: z.enum(["markdown", "json"]),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  })
  .strict();

const specShowSpillEnvelopeBaseSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("spec show"),
    storage: z.literal("artifact"),
    reason: z.literal("stdout_budget_exceeded"),
    artifact: specShowArtifactSchema
      .extend({ format: z.literal("json") })
      .strict(),
  })
  .strict();

export const specShowOutlineSpillEnvelopeSchema =
  specShowSpillEnvelopeBaseSchema
    .extend({ view: z.literal("outline") })
    .strict();

export const specShowSummarySpillEnvelopeSchema =
  specShowSpillEnvelopeBaseSchema
    .extend({ view: z.literal("summary") })
    .strict();

export const specShowOutlineEnvelopeSchema = z.discriminatedUnion("storage", [
  specShowOutlineInlineEnvelopeSchema,
  specShowOutlineSpillEnvelopeSchema,
]);

export const specShowSummaryEnvelopeSchema = z.discriminatedUnion("storage", [
  specShowSummaryInlineEnvelopeSchema,
  specShowSummarySpillEnvelopeSchema,
]);

export const specShowRenderedEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("spec show"),
    view: z.literal("rendered"),
    storage: z.literal("artifact"),
    revision: specShowArtifactRevisionSchema,
    artifact: specShowArtifactSchema
      .extend({ format: z.literal("markdown") })
      .strict(),
  })
  .strict();

export const specShowFullEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("spec show"),
    view: z.literal("full"),
    storage: z.literal("artifact"),
    revision: specShowArtifactRevisionSchema,
    artifact: specShowArtifactSchema
      .extend({ format: z.literal("json") })
      .strict(),
  })
  .strict();

export const specShowArtifactEnvelopeSchema = z.discriminatedUnion("view", [
  specShowRenderedEnvelopeSchema,
  specShowFullEnvelopeSchema,
]);

const specStatusExecutionEnvelopeSchema = specStatusViewSchema.shape.executions
  .unwrap()
  .element.extend({
    laneState: z.enum([
      "running",
      "merge_pending",
      "halted",
      "awaiting_workflow_approval",
      "not_launched",
    ]),
    actsNext: z.enum(["human", "agent"]).nullable(),
  })
  .strict();

/**
 * What each enumerated status section left out. The keys are the sections the
 * text tier bounds, so the two serializations account for the same rows.
 */
const specStatusDisclosureSchema = z
  .object({
    executions: omissionSchema,
    pendingApprovals: omissionSchema,
    openQuestions: omissionSchema,
    assumptions: omissionSchema,
    taskPlan: omissionSchema,
  })
  .strict();

const specStatusProjectionSchema = z.object({
  ok: z.literal(true),
  command: z.literal("spec status"),
  storage: z.literal("inline"),
  status: specStatusViewSchema,
  executions: z.array(specStatusExecutionEnvelopeSchema),
});

export const specStatusBoundedEnvelopeSchema = specStatusProjectionSchema
  .extend({
    view: z.literal("bounded"),
    disclosure: specStatusDisclosureSchema,
  })
  .strict();

export const specStatusFullEnvelopeSchema = specStatusProjectionSchema
  .extend({ view: z.literal("full") })
  .strict();

export const specStatusSpillEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    command: z.literal("spec status"),
    view: z.enum(["bounded", "full"]),
    storage: z.literal("artifact"),
    reason: z.literal("stdout_budget_exceeded"),
    artifact: specShowArtifactSchema
      .extend({ format: z.literal("json") })
      .strict(),
  })
  .strict();

/**
 * Both levels of the status ladder plus the receipt either can spill to. The
 * union is not discriminated on `storage`: two inline views share that value,
 * and `view` alone cannot separate an inline projection from its artifact.
 */
export const specStatusEnvelopeSchema = z.union([
  specStatusBoundedEnvelopeSchema,
  specStatusFullEnvelopeSchema,
  specStatusSpillEnvelopeSchema,
]);

export type SpecStatusDisclosure = z.infer<typeof specStatusDisclosureSchema>;

const lintCountSchema = z
  .object({
    severity: lintFindingSchema.shape.severity,
    count: z.number().int().positive(),
  })
  .strict();

const lintGroupSchema = z
  .object({
    severity: lintFindingSchema.shape.severity,
    findings: z.array(lintFindingSchema),
  })
  .strict();

export const specLintEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    lint: z
      .object({
        revisionId: z.string().min(1),
        total: z.number().int().nonnegative(),
        blocking: z.number().int().nonnegative(),
        counts: z.array(lintCountSchema),
        groups: z.array(lintGroupSchema),
      })
      .strict(),
  })
  .strict();

const specContentElementGetEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    element: specElementViewSchema,
    elementId: z.string().min(1),
    kind: specElementViewSchema.shape.element.shape.element.shape.kind,
    elementVersion:
      specElementViewSchema.shape.element.shape.version.shape.elementVersion,
  })
  .strict();

const specQuestionGetEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    element: specQuestionElementViewSchema,
  })
  .strict();

const specAssumptionGetEnvelopeSchema = z
  .object({
    ok: z.literal(true),
    element: specAssumptionElementViewSchema,
  })
  .strict();

export const specGetEnvelopeSchema = z.union([
  specContentElementGetEnvelopeSchema,
  specQuestionGetEnvelopeSchema,
  specAssumptionGetEnvelopeSchema,
]);

export type SpecShowArtifact = z.infer<typeof specShowArtifactSchema>;
export type SpecShowArtifactRevision = z.infer<
  typeof specShowArtifactRevisionSchema
>;
export type SpecShowRevisionRef = z.infer<typeof specShowRevisionRefSchema>;
export type SpecShowOutlineInlineEnvelope = z.infer<
  typeof specShowOutlineInlineEnvelopeSchema
>;
export type SpecShowSummaryInlineEnvelope = z.infer<
  typeof specShowSummaryInlineEnvelopeSchema
>;

export const SPEC_READ_ENVELOPE_FIELDS = {
  show: {
    summary: payloadFields([
      specShowSummaryInlineEnvelopeSchema,
      specShowSummarySpillEnvelopeSchema,
    ]),
    outline: payloadFields([
      specShowOutlineInlineEnvelopeSchema,
      specShowOutlineSpillEnvelopeSchema,
    ]),
    rendered: payloadFields([specShowRenderedEnvelopeSchema]),
    full: payloadFields([specShowFullEnvelopeSchema]),
  },
  status: {
    bounded: payloadFields([
      specStatusBoundedEnvelopeSchema,
      specStatusSpillEnvelopeSchema,
    ]),
    full: payloadFields([
      specStatusFullEnvelopeSchema,
      specStatusSpillEnvelopeSchema,
    ]),
  },
  lint: payloadFields([specLintEnvelopeSchema]),
  get: payloadFields([
    specContentElementGetEnvelopeSchema,
    specQuestionGetEnvelopeSchema,
    specAssumptionGetEnvelopeSchema,
  ]),
} as const;
