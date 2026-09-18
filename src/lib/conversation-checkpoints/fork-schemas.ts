import { z } from "zod";

import { conversationTargetSchema } from "@/lib/conversations/conversation-target";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";

export const checkpointRelatedWorkSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("ticket"),
      ticketNumber: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("spec_task"),
      specId: z.string().min(1),
      elementId: z.string().min(1),
      revisionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("workflow_assignment"),
      executionId: z.string().min(1),
      sessionName: z.string().min(1),
      assignmentId: z.string().min(1),
      owner: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("workflow") }).strict(),
        z
          .object({ kind: z.literal("context"), contextId: z.string().min(1) })
          .strict(),
        z
          .object({
            kind: z.literal("loop_template"),
            loopGroupId: z.string().min(1),
            contextId: z.string().min(1),
          })
          .strict(),
      ]),
      useSite: z.enum(["implementer", "validator"]),
    })
    .strict(),
]);
export type CheckpointRelatedWork = z.infer<typeof checkpointRelatedWorkSchema>;

export const checkpointForkOriginSchema = z
  .object({
    submission: z
      .object({ backend: agentBackendSchema, at: z.string().min(1) })
      .strict()
      .optional(),
    source: conversationTargetSchema,
    evidenceSource: conversationTargetSchema,
    sourceOperationId: z.string().min(1),
    ordinal: z.number().int().positive(),
    schemaVersion: z.number().int().positive(),
    seedSha256: z.string().min(1),
    capturedThroughSeq: z.number().int().nonnegative(),
    operationId: z.string().min(1),
    requestHash: z.string().min(1),
    relatedWork: checkpointRelatedWorkSchema.nullable(),
    initialSelection: z
      .object({
        backend: agentBackendSchema,
        modelSelection: backendModelSelectionSchema,
      })
      .strict(),
  })
  .strict();
export type CheckpointForkOrigin = z.infer<typeof checkpointForkOriginSchema>;

export const checkpointForkRequestSchema = z
  .object({
    requestId: z.uuid(),
    name: z.string().trim().min(1).max(200),
    task: z.string().trim().max(32_768).default(""),
    relatedWork: checkpointRelatedWorkSchema.nullable().default(null),
    backend: agentBackendSchema,
    modelSelection: backendModelSelectionSchema,
  })
  .strict();
export type CheckpointForkRequest = z.infer<typeof checkpointForkRequestSchema>;
