import { z } from "zod";

import { stableStringify } from "@/lib/state-store/serialization";
import {
  actorProvenanceSchema,
  specCriterionDispositionSchema,
  type DeliveryPlanAttemptStatus,
  type SpecCriterionDisposition,
  type SpecExecutionState,
} from "./schemas";

const elementIdSchema = z.string().min(1);
const timestampSchema = z.string().min(1);
export const NATIVE_SDD_PINNED_SPEC_SOURCE_ID = "native-sdd-pinned-spec";
export const NATIVE_SDD_CLAIMS_SOURCE_ID = "native-sdd-claims";

export const DELIVERY_PLAN_ENVELOPE_MAX_BYTES = 1_048_576;

export const deliveryPlanCriterionDispositionSchema = z.enum([
  ...specCriterionDispositionSchema.options,
  "reaffirmed",
  "pending_reaffirmation",
]);
export type DeliveryPlanCriterionDisposition = z.infer<
  typeof deliveryPlanCriterionDispositionSchema
>;

export function executionDispositionFromDeliveryPlan(
  disposition: DeliveryPlanCriterionDisposition,
): SpecCriterionDisposition {
  if (disposition === "reaffirmed") return "delivered_elsewhere";
  if (disposition === "pending_reaffirmation") {
    throw new Error("A pending reaffirmation cannot be started.");
  }
  return disposition;
}

export function exclusionDispositionFromDeliveryPlan(
  disposition: Exclude<DeliveryPlanCriterionDisposition, "in_scope">,
): Exclude<SpecCriterionDisposition, "in_scope"> {
  const executionDisposition =
    executionDispositionFromDeliveryPlan(disposition);
  if (executionDisposition === "in_scope") {
    throw new Error("An in-scope criterion cannot be an exclusion.");
  }
  return executionDisposition;
}

export const deliveryPlanBindingDispositionSchema = z
  .object({
    criterionElementId: elementIdSchema,
    disposition: deliveryPlanCriterionDispositionSchema,
    deliveredByExecutionId: elementIdSchema.nullable(),
  })
  .strict();

export const deliveryPlanClaimSchema = z
  .object({
    contextId: elementIdSchema,
    criterionElementIds: z.array(elementIdSchema).min(1),
  })
  .strict();
export type DeliveryPlanClaim = z.infer<typeof deliveryPlanClaimSchema>;

export const deliveryPlanBindingV3Schema = z
  .object({
    dispositions: z.array(deliveryPlanBindingDispositionSchema),
    claims: z.array(deliveryPlanClaimSchema),
  })
  .strict();
export const deliveryPlanBindingSchema = z.strictObject(
  { dispositions: z.array(deliveryPlanBindingDispositionSchema) },
  {
    error:
      "Bindings contain dispositions only; author claims using acceptanceCriteria[].covers.",
  },
);
export type DeliveryPlanBinding = z.infer<typeof deliveryPlanBindingSchema>;

function checkDocumentSize(document: unknown, context: z.RefinementCtx): void {
  const byteLength = new TextEncoder().encode(
    stableStringify(document),
  ).byteLength;
  if (byteLength > DELIVERY_PLAN_ENVELOPE_MAX_BYTES) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `Delivery plan binding is ${byteLength} bytes; the whole-document limit is ${DELIVERY_PLAN_ENVELOPE_MAX_BYTES} bytes.`,
    });
  }
}

function checkCandidateIdentity(
  manifest: { candidateId: string; workflowDefinition: { id: string } },
  context: z.RefinementCtx,
): void {
  if (manifest.candidateId !== manifest.workflowDefinition.id) {
    context.addIssue({
      code: "custom",
      path: ["candidateId"],
      message: "candidateId must equal workflowDefinition.id",
    });
  }
}

export const deliveryPlanV3DocumentSchema = z
  .object({
    schemaVersion: z.literal(3),
    binding: deliveryPlanBindingV3Schema,
  })
  .strict()
  .superRefine(checkDocumentSize);
export type DeliveryPlanV3Document = z.infer<
  typeof deliveryPlanV3DocumentSchema
>;

const sha256HashSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const deliveryPlanCandidateManifestV3Schema = z
  .object({
    protocol: z.literal("native-sdd-delivery-candidate/v3"),
    schemaVersion: z.literal(3),
    specId: elementIdSchema,
    attemptId: elementIdSchema,
    candidateId: elementIdSchema,
    pinnedRevisionId: elementIdSchema,
    draftRevision: z.number().int().positive(),
    workflowDefinition: z
      .object({
        id: elementIdSchema,
        revision: z.number().int().positive(),
        definitionHash: sha256HashSchema,
      })
      .strict(),
    binding: deliveryPlanBindingV3Schema,
    bindingHash: sha256HashSchema,
  })
  .strict()
  .superRefine(checkCandidateIdentity);
export type DeliveryPlanCandidateManifestV3 = z.infer<
  typeof deliveryPlanCandidateManifestV3Schema
>;

export function canonicalDeliveryPlanEnvelopeBytes(
  document: DeliveryPlanDocument,
): string {
  return stableStringify(document);
}

export const deliveryPlanV4DocumentSchema = z
  .object({ schemaVersion: z.literal(4), binding: deliveryPlanBindingSchema })
  .strict()
  .superRefine(checkDocumentSize);
export const deliveryPlanDocumentSchema = z.discriminatedUnion(
  "schemaVersion",
  [deliveryPlanV3DocumentSchema, deliveryPlanV4DocumentSchema],
);
export type DeliveryPlanDocument = z.infer<typeof deliveryPlanDocumentSchema>;

export const deliveryPlanCandidateManifestV4Schema = z
  .object({
    ...deliveryPlanCandidateManifestV3Schema.shape,
    protocol: z.literal("native-sdd-delivery-candidate/v4"),
    schemaVersion: z.literal(4),
    binding: deliveryPlanBindingSchema,
    claims: z.array(deliveryPlanClaimSchema),
  })
  .strict()
  .superRefine(checkCandidateIdentity);
export const deliveryPlanCandidateRecordSchema = z.discriminatedUnion(
  "schemaVersion",
  [
    deliveryPlanCandidateManifestV3Schema,
    deliveryPlanCandidateManifestV4Schema,
  ],
);
export type DeliveryPlanCandidateRecord = z.infer<
  typeof deliveryPlanCandidateRecordSchema
>;

export function deliveryPlanCandidateClaims(
  candidate: DeliveryPlanCandidateRecord,
): DeliveryPlanClaim[] {
  return candidate.schemaVersion === 4
    ? candidate.claims
    : candidate.binding.claims;
}

export function canonicalDeliveryPlanCandidateBytes(
  candidate: DeliveryPlanCandidateRecord,
): string {
  return stableStringify(candidate);
}

export function pinnedSpecDocumentPath(slug: string): string {
  return `.cc/graph-workflow-docs/spec/${slug}.md`;
}

/** The immutable identity of one finalized launch envelope. */
export const finalizedDeliveryPlanCandidateIdentitySchema = z
  .object({
    candidateId: elementIdSchema,
    candidateHash: z.string().min(1),
  })
  .strict();
export type FinalizedDeliveryPlanCandidateIdentity = z.infer<
  typeof finalizedDeliveryPlanCandidateIdentitySchema
>;

export const finalizedDeliveryPlanApprovalSchema =
  finalizedDeliveryPlanCandidateIdentitySchema
    .extend({
      snapshotId: elementIdSchema,
      approvedAt: timestampSchema,
      approvedBy: actorProvenanceSchema,
    })
    .strict();
export type FinalizedDeliveryPlanApproval = z.infer<
  typeof finalizedDeliveryPlanApprovalSchema
>;

export const finalizedDeliveryPlanPrelaunchSchema = z
  .object({
    parkedAt: timestampSchema,
    parkedBy: actorProvenanceSchema,
    reason: z.string().max(2000).nullable(),
    candidate: finalizedDeliveryPlanCandidateIdentitySchema,
    approvedAtPark: z.boolean(),
  })
  .strict();
export type FinalizedDeliveryPlanPrelaunch = z.infer<
  typeof finalizedDeliveryPlanPrelaunchSchema
>;

export function liveDeliveryPlanAttempt<
  T extends { readonly status: DeliveryPlanAttemptStatus },
>(attempts: readonly T[]): T | null {
  const live = attempts.filter((attempt) => attempt.status !== "abandoned");
  return live[live.length - 1] ?? null;
}

/**
 * A spec execution that will not run again. `abandoning` is deliberately not
 * terminal: its cleanup coordinator is still working through `cleanup_phase`
 * and still owns the attempt's launched run.
 */
export function isTerminalSpecExecutionState(
  state: SpecExecutionState,
): boolean {
  return state === "delivered" || state === "abandoned";
}

/**
 * Whether the live attempt still stands in the way of opening a replacement.
 *
 * A launched attempt stops blocking once the execution it launched reaches a
 * terminal state. The execution is the single owner of whether its run is
 * over, so this is read from the execution rather than mirrored onto the
 * attempt row, where the two could drift — a delivery that committed while an
 * attempt-side status write failed would otherwise strand the spec.
 *
 * Without this, a spec could plan exactly one delivery: nothing retires a
 * launched attempt on success, so `open` refused forever and
 * Explicit seed selection was unreachable in the very case it existed for.
 *
 * An unresolvable execution keeps blocking. Failing closed beats forking a
 * second plan over a run that may still be live.
 */
export function deliveryPlanAttemptBlocksReplacement(input: {
  readonly status: DeliveryPlanAttemptStatus;
  readonly launchedExecutionState: SpecExecutionState | null;
}): boolean {
  if (input.status !== "launched") return true;
  if (input.launchedExecutionState === null) return true;
  return !isTerminalSpecExecutionState(input.launchedExecutionState);
}

/**
 * The id in both the sentence and the `--execution` form is the WORKFLOW
 * execution id (design 3.5, D-B): it is the only execution id agents hold, and
 * the only one the capture and abandon verbs accept. A caller that holds
 * neither the slug nor that id — the delivery-plan repository, which owns
 * neither the spec table nor the execution binding — passes neither and gets
 * the `<slug>` usage form. That is deliberately a template rather than a
 * spec-side row id: the row id would render a command the resolver refuses,
 * while the slug is the one thing the caller of the refused verb just typed.
 */
export function postLaunchPathActs(input: {
  readonly slug?: string;
  readonly workflowExecutionId?: string;
}): readonly [string, string] {
  const target =
    input.slug ??
    (input.workflowExecutionId === undefined
      ? "<slug>"
      : `--execution ${input.workflowExecutionId}`);
  return [
    `record a non-blocking discovery for the next plan with \`cctl spec capture ${target} --file <task.json>\``,
    `abandon this run and open a replacement with \`cctl spec capture ${target} --file <task.json> --blocking-reason <why>\``,
  ];
}

export function postLaunchPathsSentence(input: {
  readonly slug?: string;
  readonly workflowExecutionId?: string;
}): string {
  const running =
    input.workflowExecutionId === undefined
      ? "The plan is already running"
      : `The plan is already running as execution ${input.workflowExecutionId}`;
  return `${running}, so its launch and binding are immutable. Take one of the post-launch paths: ${postLaunchPathActs(
    input,
  ).join("; ")}.`;
}
