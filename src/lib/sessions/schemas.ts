import { z } from "zod";
import {
  conversationProfileSelectionSchema,
  conversationStateSchema,
  publicConversationStateSchema,
  toPublicConversationStates,
} from "@/lib/conversations/schemas";
import { referenceDocumentSchema } from "@/lib/reference-documents/schemas";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  sessionCreationModeSchema,
  sessionSourceSchema,
  spawnedFromSchema,
} from "./list-schemas";

export {
  branchPrefixResponseSchema,
  derivedSessionStatusSchema,
  sessionCreationModeSchema,
  sessionListItemSchema,
  sessionsResponseSchema,
  sessionSourceSchema,
  spawnedFromSchema,
} from "./list-schemas";
export type {
  BranchPrefixResponse,
  DerivedSessionStatus,
  SessionCreationMode,
  SessionListItem,
  SpawnedFrom,
} from "./list-schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "split" | "panes" | "diff";

export const sessionStateSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean().default(false),
  finished: z.boolean().default(false),
  conversations: z.array(conversationStateSchema).default([]),
  source: sessionSourceSchema.default("cc"),
  creationMode: sessionCreationModeSchema.default("normal"),
  tddEnabled: z.boolean().default(true),
  targetBranch: z.string().default("main"),
  parentSessionName: z.string().nullable().default(null),
  graphWorkflowExecution: graphWorkflowExecutionSchema.nullable().default(null),
  referenceDocuments: z.array(referenceDocumentSchema).default([]),
  // Workflow envelope durable persistence for the workflow primitive layer.
  // Stored as opaque records here to avoid pulling primitive-layer schemas into
  // schemas.ts. Validation runs at the WorkflowEnvelopeStore boundary via
  // workflowEnvelopeSchema.parse() in src/lib/workflows/primitives.
  workflowEnvelopes: z.record(z.string(), z.unknown()).optional(),
  // Workflow lane durable persistence for the workflow primitive layer.
  // Stored as opaque records for the same reason as workflowEnvelopes; the
  // LaneStore boundary validates entries with laneStateSchema.
  workflowLanes: z.record(z.string(), z.unknown()).optional(),
  mcpOverrides: mcpOverridesSchema.optional(),
  agentCapabilityOverrides: agentCapabilityOverridesSchema.optional(),
  // Origin tag for sessions spawned from a project conversation's spawn card.
  // Nullable+optional (like the PLC-only `open`/`spawnedSessionIds` fields) so
  // the ~30 existing SessionState literal sites decode unchanged; the sessions
  // repo always materializes an explicit value on decode — `null` for
  // legacy/non-spawned rows, the chat origin for spawned sessions.
  spawnedFrom: spawnedFromSchema.nullable().optional(),
});
export type SessionState = z.infer<typeof sessionStateSchema>;

/**
 * A session as a read surface may carry it. A session's `conversations` are
 * stored rows, so the two routes that serialize a whole session (create, get)
 * must project them; the differing `conversations` element type means the
 * compiler refuses an unprojected session at either egress.
 */
export const publicSessionStateSchema = sessionStateSchema.extend({
  conversations: z.array(publicConversationStateSchema).default([]),
});
export type PublicSessionState = z.infer<typeof publicSessionStateSchema>;

export function toPublicSessionState(
  session: SessionState,
): PublicSessionState {
  return {
    ...session,
    conversations: toPublicConversationStates(session.conversations),
  };
}

export const bulkSessionsRequestSchema = z.object({
  op: z.enum(["archive", "unarchive", "delete"]),
  sessionNames: z.array(z.string().min(1)).min(1).max(200),
});
export type BulkSessionsRequest = z.infer<typeof bulkSessionsRequestSchema>;

const bulkSessionResultSchema = z.object({
  sessionName: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
});
export type BulkSessionResult = z.infer<typeof bulkSessionResultSchema>;

export const bulkSessionsResponseSchema = z.object({
  results: z.array(bulkSessionResultSchema),
});
export type BulkSessionsResponse = z.infer<typeof bulkSessionsResponseSchema>;

export const createSessionRequestSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("normal"),
      sessionName: z.string().trim().min(1),
      tddEnabled: z.boolean().optional(),
      parentSessionName: z.string().trim().min(1).optional(),
      // Profile for the session's initial conversation; omitting it yields the
      // Standard Agent default (R7). Separate from backend/model/effort, which
      // stay with the runtime cascade.
      profile: conversationProfileSelectionSchema.optional(),
    }),
    z.object({
      mode: z.literal("optimistic"),
      instructions: z.string().trim(),
      images: z.array(imagePayloadSchema).max(5).optional(),
      tddEnabled: z.boolean().optional(),
      parentSessionName: z.string().trim().min(1).optional(),
      profile: conversationProfileSelectionSchema.optional(),
    }),
  ])
  .superRefine((request, context) => {
    if (
      request.mode === "optimistic" &&
      !request.instructions &&
      !request.images?.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["instructions"],
        message: "Optimistic sessions require instructions or an image",
      });
    }
  });
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionArchiveRequestSchema = z.object({
  archived: z.boolean(),
});

export const sessionMergeStatusRequestSchema = z
  .object({ merged: z.boolean() })
  .strict();

export const sessionTddRequestSchema = z.object({
  tddEnabled: z.boolean(),
});
