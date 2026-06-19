/**
 * Discriminated schema for the collaboration `featureSnapshot` field.
 *
 * The primitive `workflowEnvelopeSchema.featureSnapshot` stays `z.unknown()`;
 * this schema is the contract the collaboration feature itself reads and
 * writes through. Two variants keyed on `origin`:
 *
 *  - `"user"`  — the existing user-triggered envelope shape, captured
 *                permissively so persisted JSONL records continue to round-trip
 *                without a data migration. Existing records on disk do not
 *                carry an `origin` field; the schema defaults the
 *                discriminator to `"user"` when absent on read.
 *  - `"workflow"` — the agent-invoked shape: carries
 *                `parentImplementerTurnId`, `executionContextId`,
 *                `conversationId`, and the resolved collaboration config (each
 *                resolved field carries `value` + `source` per the cascade).
 *                The ordered artifact stream (initial drafts, cross-reviews,
 *                proposed/counter changes, resolutions, final answer) lives in
 *                a per-workflow JSONL sidecar
 *                (`@/lib/workflows/collaboration/artifacts-store`), not in this
 *                blob, so the envelope holds only bounded lifecycle/config
 *                state. The element shape persisted there is
 *                `CollaborationWorkflowArtifactEntry`.
 */

import { z } from "zod";
import {
  collaborationCounterProposalOutputSchema,
  collaborationCrossReviewOutputSchema,
  collaborationFinalAnswerOutputSchema,
  collaborationInitialDraftOutputSchema,
  collaborationProposedChangesOutputSchema,
  collaborationResolutionDecisionOutputSchema,
  resolvedCollaborationConfigSchema,
} from "@/lib/workflows/schemas";

const collaborationFeatureSnapshotUserSchema = z
  .object({
    origin: z.literal("user"),
  })
  .passthrough();

export const collaborationWorkflowArtifactEntrySchema = z.discriminatedUnion(
  "kind",
  [
  z.object({
    kind: z.literal("initial_draft"),
    agent: z.enum(["agent_one", "agent_two"]),
    value: collaborationInitialDraftOutputSchema,
  }),
  z.object({
    kind: z.literal("cross_review"),
    agent: z.literal("agent_two"),
    value: collaborationCrossReviewOutputSchema,
  }),
  z.object({
    kind: z.literal("proposed_changes"),
    agent: z.literal("agent_one"),
    round: z.number().int().positive(),
    value: collaborationProposedChangesOutputSchema,
  }),
  z.object({
    kind: z.literal("counter_proposal"),
    agent: z.literal("agent_two"),
    round: z.number().int().positive(),
    value: collaborationCounterProposalOutputSchema,
  }),
  z.object({
    kind: z.literal("resolution_decision"),
    agent: z.literal("agent_one"),
    round: z.number().int().positive(),
    value: collaborationResolutionDecisionOutputSchema,
  }),
  z.object({
    kind: z.literal("final_answer"),
    agent: z.literal("agent_one"),
    value: collaborationFinalAnswerOutputSchema,
  }),
  ],
);
export type CollaborationWorkflowArtifactEntry = z.infer<
  typeof collaborationWorkflowArtifactEntrySchema
>;

const collaborationFeatureSnapshotWorkflowSchema = z.object({
  origin: z.literal("workflow"),
  parentImplementerTurnId: z.string().trim().min(1),
  executionContextId: z.string().trim().min(1),
  conversationId: z.string().trim().min(1),
  resolvedConfig: resolvedCollaborationConfigSchema,
});

const discriminatedUnion = z.discriminatedUnion("origin", [
  collaborationFeatureSnapshotUserSchema,
  collaborationFeatureSnapshotWorkflowSchema,
]);

export const collaborationFeatureSnapshotSchema = z.preprocess((value) => {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !("origin" in value)
  ) {
    return { ...(value as Record<string, unknown>), origin: "user" };
  }
  return value;
}, discriminatedUnion);

export type CollaborationFeatureSnapshot = z.infer<
  typeof collaborationFeatureSnapshotSchema
>;

export type CollaborationFeatureSnapshotUser = z.infer<
  typeof collaborationFeatureSnapshotUserSchema
>;

export type CollaborationFeatureSnapshotWorkflow = z.infer<
  typeof collaborationFeatureSnapshotWorkflowSchema
>;
