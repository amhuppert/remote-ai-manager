import { z } from "zod";

import {
  deliveryPlanBindingDispositionSchema,
  deliveryPlanClaimSchema,
  exclusionDispositionFromDeliveryPlan,
} from "./delivery-plan";
import {
  specCriterionDispositionSchema,
  type SpecCriterionDisposition,
} from "./schemas";

const bindingIdSchema = z.string().trim().min(1).max(120);
const bindingPathSchema = z.string().trim().min(1).max(500);

export const specExecutionBindingDispositionSchema = z
  .object({
    criterionElementId: bindingIdSchema,
    disposition: specCriterionDispositionSchema,
    deliveredByExecutionId: bindingIdSchema.nullable(),
  })
  .strict();

/**
 * A claim attaches spec delivery accountability to an opaque graph-authored
 * source id. The binding never interprets that id as graph topology.
 */
export const specExecutionBindingClaimSchema = z
  .object({
    accountabilitySourceId: bindingIdSchema,
    taskElementId: bindingIdSchema.nullable(),
    touchedPaths: z.array(bindingPathSchema).max(300),
    criterionElementIds: z.array(bindingIdSchema).max(500),
  })
  .strict();

/** The spec-owned sidecar frozen with a candidate and copied to its execution. */
export const specExecutionBindingSchema = z
  .object({
    dispositions: z.array(specExecutionBindingDispositionSchema).max(500),
    claims: z.array(specExecutionBindingClaimSchema).max(1000),
  })
  .strict();
export type SpecExecutionBinding = z.infer<typeof specExecutionBindingSchema>;

/**
 * The immutable direct-plan binding copied from finalized candidate bytes into
 * the authoritative one-to-one execution link. Candidate identity and the
 * pinned revision travel with the sidecar so every execution-id lookup can
 * reject a stale or cross-candidate row without consulting graph provenance.
 */
export const specExecutionBindingSnapshotV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    candidateId: bindingIdSchema,
    candidateHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    pinnedRevisionId: bindingIdSchema,
    dispositions: z.array(deliveryPlanBindingDispositionSchema),
    claims: z.array(deliveryPlanClaimSchema),
  })
  .strict();
export type SpecExecutionBindingSnapshotV2 = z.infer<
  typeof specExecutionBindingSnapshotV2Schema
>;

export interface LinkedSpecExecutionBindingV2 {
  specExecutionId: string;
  workflowExecutionId: string;
  binding: SpecExecutionBindingSnapshotV2;
  createdAt: string;
}

export interface SpecExecutionBindingExpectedIdentity {
  specExecutionId?: string;
  candidateId?: string;
  candidateHash?: string;
  pinnedRevisionId?: string;
}

export class SpecExecutionBindingNotFoundError extends Error {
  readonly code = "spec_execution_binding_not_found" as const;

  constructor(readonly workflowExecutionId: string) {
    super(
      `Workflow execution ${workflowExecutionId} has no authoritative native-SDD execution binding`,
    );
    this.name = "SpecExecutionBindingNotFoundError";
  }
}

export class SpecExecutionBindingMismatchError extends Error {
  readonly code = "spec_execution_binding_mismatch" as const;

  constructor(
    readonly workflowExecutionId: string,
    readonly field: keyof SpecExecutionBindingExpectedIdentity,
  ) {
    super(
      `Workflow execution ${workflowExecutionId} has a native-SDD binding whose ${field} does not match the expected execution identity`,
    );
    this.name = "SpecExecutionBindingMismatchError";
  }
}

/**
 * One narrow read boundary shared by execution-contract, prompt, live-edit,
 * and delivery adapters. Consumers resolve from the graph execution id and do
 * not inspect graph origin or metadata to discover whether a binding exists.
 */
export interface SpecExecutionBindingReader {
  findByWorkflowExecutionId(
    workflowExecutionId: string,
  ): LinkedSpecExecutionBindingV2 | null;
  requireByWorkflowExecutionId(
    workflowExecutionId: string,
    expected?: SpecExecutionBindingExpectedIdentity,
  ): LinkedSpecExecutionBindingV2;
}

export function executionScopeFromBinding(binding: SpecExecutionBinding): {
  selectedTaskIds: string[];
  selectedCriterionIds: string[];
  exclusionDispositions: {
    criterionId: string;
    disposition: Exclude<SpecCriterionDisposition, "in_scope">;
  }[];
} {
  return {
    selectedTaskIds: [],
    selectedCriterionIds: binding.dispositions
      .filter((entry) => entry.disposition === "in_scope")
      .map((entry) => entry.criterionElementId),
    exclusionDispositions: binding.dispositions.flatMap((entry) =>
      entry.disposition === "in_scope"
        ? []
        : [
            {
              criterionId: entry.criterionElementId,
              disposition: exclusionDispositionFromDeliveryPlan(
                entry.disposition,
              ),
            },
          ],
    ),
  };
}
