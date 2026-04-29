/**
 * Workflow envelope vocabulary for the workflow primitive layer.
 *
 * Models a minimal durable lifecycle wrapper for workflows that need to be
 * discoverable across server restarts (graph workflow executions, future
 * collaboration mode runs, long-lived background workflows). The envelope is
 * intentionally NOT a generic child-object store: lanes, gates, and artifacts
 * remain owned by their respective primitive stores. The envelope only carries
 * the shared lifecycle metadata every long-running workflow needs:
 *
 *  - identity (`workflowId`) and feature kind (`workflowType`)
 *  - lifecycle status (`running` / `paused` / `completed` / `failed`)
 *  - a feature-defined `phase` string for surface-level UI labeling
 *  - lifecycle timestamps (`createdAt` / `updatedAt` / optional `completedAt`)
 *  - a shared `errorSummary` for failed envelopes
 *  - an optional `parentWorkflowId` so child workflows are discoverable from
 *    their parent
 *  - an optional shared `pause` projection that preserves the mid-turn vs
 *    post-turn distinction so resumes target the correct state after restart
 *  - an opaque `featureSnapshot` that the owning feature defines and reads
 *
 * The `featureSnapshot` deliberately stays untyped at the primitive layer so
 * adding a new workflow type does not require schema changes here. Domain
 * specific recovery decisions (replay strategy, idempotency, retry policy)
 * live with the feature that owns the snapshot shape.
 *
 * The `pause` projection mirrors the gate vocabulary's `pauseKind` invariants:
 *  - `ask_user` gate pauses are always `mid_turn`
 *  - `human_approval` gate pauses are always `post_turn`
 *
 * That coupling is enforced inside `workflowEnvelopePauseSchema` so a paused
 * envelope read back from disk after a server restart still distinguishes a
 * mid-turn ask-user pause from a post-turn approval pause without consulting
 * the feature snapshot.
 */

import { z } from "zod";
import { pauseKindSchema } from "./agent-call-vocabulary";
import { gateKindSchema } from "./gate-vocabulary";

export const WORKFLOW_ENVELOPE_STATUSES = [
  "running",
  "paused",
  "completed",
  "failed",
] as const;

export const workflowEnvelopeStatusSchema = z.enum(WORKFLOW_ENVELOPE_STATUSES);
export type WorkflowEnvelopeStatus = z.infer<
  typeof workflowEnvelopeStatusSchema
>;

export const workflowEnvelopePauseSchema = z
  .object({
    pauseKind: pauseKindSchema,
    gateKind: gateKindSchema,
    resumeToken: z.string().min(1),
    reason: z.string().min(1).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.gateKind === "ask_user" && value.pauseKind !== "mid_turn") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ask_user gate pauses must be mid_turn",
        path: ["pauseKind"],
      });
    }
    if (
      value.gateKind === "human_approval" &&
      value.pauseKind !== "post_turn"
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_approval gate pauses must be post_turn",
        path: ["pauseKind"],
      });
    }
  });
export type WorkflowEnvelopePause = z.infer<typeof workflowEnvelopePauseSchema>;

export const workflowEnvelopeSchema = z
  .object({
    workflowId: z.string().min(1),
    workflowType: z.string().min(1),
    status: workflowEnvelopeStatusSchema,
    phase: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    completedAt: z.string().min(1).optional(),
    errorSummary: z.string().min(1).optional(),
    parentWorkflowId: z.string().min(1).optional(),
    pause: workflowEnvelopePauseSchema.optional(),
    featureSnapshot: z.unknown(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "paused" && value.pause === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "paused envelopes must carry a pause projection",
        path: ["pause"],
      });
    }
    if (value.status !== "paused" && value.pause !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "pause projection is only allowed when status is paused; clear it on resume/complete/fail",
        path: ["pause"],
      });
    }
    if (
      value.status === "failed" &&
      (value.errorSummary === undefined ||
        value.errorSummary.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "failed envelopes must carry a non-empty errorSummary",
        path: ["errorSummary"],
      });
    }
    if (!Object.prototype.hasOwnProperty.call(value, "featureSnapshot")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "featureSnapshot is required (use null when the workflow has no snapshot yet)",
        path: ["featureSnapshot"],
      });
    } else if (value.featureSnapshot === undefined) {
      // Reject an own-property value of `undefined`: JSON.stringify drops it,
      // so a session-state round-trip would silently lose the field and the
      // envelope would no longer satisfy the required-snapshot contract on
      // restart. Callers must use `null` for "no snapshot yet".
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "featureSnapshot must not be undefined (JSON serialization drops undefined fields; use null for an empty snapshot)",
        path: ["featureSnapshot"],
      });
    }
  });
export type WorkflowEnvelope = z.infer<typeof workflowEnvelopeSchema>;
