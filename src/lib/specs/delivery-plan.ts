import { z } from "zod";

import { stableStringify } from "@/lib/state-store/serialization";
import { workflowDefinitionMutationSchema } from "@/lib/workflow-graph/definition-schemas";
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
const RESERVED_SOURCE_IDS = new Set([
  NATIVE_SDD_PINNED_SPEC_SOURCE_ID,
  NATIVE_SDD_CLAIMS_SOURCE_ID,
]);
const RESERVED_SOURCE_LOCATOR_PREFIXES = [
  ".cc/graph-workflow-docs/spec/",
  ".cc/graph-workflow-docs/spec-bindings/",
] as const;

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
export type DeliveryPlanBindingDisposition = z.infer<
  typeof deliveryPlanBindingDispositionSchema
>;

export const deliveryPlanClaimSchema = z
  .object({
    contextId: elementIdSchema,
    criterionElementIds: z.array(elementIdSchema).min(1),
  })
  .strict();
export type DeliveryPlanClaim = z.infer<typeof deliveryPlanClaimSchema>;

export const deliveryPlanBindingSchema = z
  .object({
    dispositions: z.array(deliveryPlanBindingDispositionSchema),
    claims: z.array(deliveryPlanClaimSchema),
  })
  .strict();
export type DeliveryPlanBinding = z.infer<typeof deliveryPlanBindingSchema>;

export function canonicalDeliveryPlanEnvelopeBytes(
  document: DeliveryPlanDocument,
): string {
  return stableStringify(document);
}

export function deliveryPlanEnvelopeByteLength(
  document: DeliveryPlanDocument,
): number {
  return new TextEncoder().encode(canonicalDeliveryPlanEnvelopeBytes(document))
    .byteLength;
}

/**
 * A native-SDD attempt carries the graph-owned launch verbatim and the thin
 * spec-owned accountability binding paired with it. Graph structure, layout,
 * runtime settings, and dynamic behavior belong exclusively to `launch`.
 */
export const finalizedDeliveryPlanDocumentSchema = z
  .object({
    schemaVersion: z.literal(2),
    launch: workflowDefinitionMutationSchema,
    binding: deliveryPlanBindingSchema,
  })
  .strict();
export type FinalizedDeliveryPlanDocument = z.infer<
  typeof finalizedDeliveryPlanDocumentSchema
>;

export const deliveryPlanDocumentSchema =
  finalizedDeliveryPlanDocumentSchema.superRefine((document, context) => {
    const definition = document.launch.definition;
    if (definition.origin !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["launch", "definition", "origin"],
        message: "definition.origin is reserved for server finalization.",
      });
    }
    if (definition.lockedRegions !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["launch", "definition", "lockedRegions"],
        message:
          "definition.lockedRegions is reserved for server finalization.",
      });
    }
    if (definition.approvalRequired !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["launch", "definition", "approvalRequired"],
        message:
          "definition.approvalRequired is reserved for server finalization.",
      });
    }

    for (const [index, source] of definition.charter.sourcesOfTruth.entries()) {
      if (RESERVED_SOURCE_IDS.has(source.id)) {
        context.addIssue({
          code: "custom",
          path: [
            "launch",
            "definition",
            "charter",
            "sourcesOfTruth",
            index,
            "id",
          ],
          message: `Source id ${JSON.stringify(source.id)} is reserved for server finalization.`,
        });
      }
      if (
        RESERVED_SOURCE_LOCATOR_PREFIXES.some((prefix) =>
          source.locator.startsWith(prefix),
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [
            "launch",
            "definition",
            "charter",
            "sourcesOfTruth",
            index,
            "locator",
          ],
          message: `Source locator ${JSON.stringify(source.locator)} is reserved for server finalization.`,
        });
      }
    }

    const byteLength = deliveryPlanEnvelopeByteLength(document);
    if (byteLength > DELIVERY_PLAN_ENVELOPE_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: [],
        message: `Delivery plan envelope is ${byteLength} bytes; the whole-envelope limit is ${DELIVERY_PLAN_ENVELOPE_MAX_BYTES} bytes.`,
      });
    }
  });
export type DeliveryPlanDocument = z.infer<typeof deliveryPlanDocumentSchema>;

export const deliveryPlanCandidateRecordSchema = z
  .object({
    protocol: z.literal("native-sdd-delivery-candidate/v2"),
    schemaVersion: z.literal(2),
    specId: elementIdSchema,
    attemptId: elementIdSchema,
    candidateId: elementIdSchema,
    pinnedRevisionId: elementIdSchema,
    draftRevision: z.number().int().positive(),
    document: finalizedDeliveryPlanDocumentSchema,
  })
  .strict();
export type DeliveryPlanCandidateRecord = z.infer<
  typeof deliveryPlanCandidateRecordSchema
>;

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
 * `--seed-from last` was unreachable in the very case it exists for.
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

export function postLaunchPathActs(input: {
  readonly slug?: string;
  readonly executionId: string;
}): readonly [string, string] {
  const target = input.slug ?? `--execution ${input.executionId}`;
  return [
    `record a non-blocking discovery for the next plan with \`cctl spec capture ${target} --file <task.json>\``,
    `abandon this run and open a replacement with \`cctl spec capture ${target} --file <task.json> --blocking-reason <why>\``,
  ];
}

export function postLaunchPathsSentence(input: {
  readonly slug?: string;
  readonly executionId: string;
}): string {
  return `The plan is already running as execution ${input.executionId}, so its launch and binding are immutable. Take one of the post-launch paths: ${postLaunchPathActs(
    input,
  ).join("; ")}.`;
}
