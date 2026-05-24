import { z } from "zod";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { referenceDocumentSchema } from "@/lib/reference-documents/schemas";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "default" | "split" | "diff";

/** Session-level derived status (waiting_for_input > running > awaiting > new > idle) */
export const derivedSessionStatusSchema = z.enum([
  "waiting_for_input",
  "running",
  "awaiting",
  "new",
  "idle",
]);
export type DerivedSessionStatus = z.infer<typeof derivedSessionStatusSchema>;

export const sessionSourceSchema = z.enum(["cc", "imported"]);

export const sessionCreationModeSchema = z.enum([
  "fast",
  "focus",
  "optimistic",
]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

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
  objective: z.string().nullable().default(null),
  creationMode: sessionCreationModeSchema.default("fast"),
  tddEnabled: z.boolean().default(true),
  targetBranch: z.string().default("main"),
  parentSessionName: z.string().nullable().default(null),
  graphWorkflowExecution: graphWorkflowExecutionSchema.nullable().default(null),
  graphWorkflowExecutionHistory: z
    .array(graphWorkflowExecutionSchema)
    .default([]),
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
});
export type SessionState = z.infer<typeof sessionStateSchema>;

// Slim per-row shape for the sessions-list accessor. Defined explicitly (NOT
// via sessionStateSchema.omit/extend) so heavy fields added to sessionStateSchema
// in the future do not silently leak into the list payload.
export const sessionListItemSchema = z.object({
  sessionName: z.string(),
  worktreePath: z.string(),
  branchName: z.string(),
  targetBranch: z.string(),
  parentSessionName: z.string().nullable(),
  createdAt: z.string(),
  lastActivityAt: z.string(),
  archived: z.boolean(),
  finished: z.boolean(),
  source: sessionSourceSchema,
  creationMode: sessionCreationModeSchema,
  tddEnabled: z.boolean(),
  objective: z.string().nullable(),
  derivedStatus: derivedSessionStatusSchema,
  promptCount: z.number().int().nonnegative(),
  derivedLastActivityAt: z.string(),
  collabContribution: z.enum(["running", "paused"]).nullable(),
  hasActiveGraphWorkflow: z.boolean(),
});
export type SessionListItem = z.infer<typeof sessionListItemSchema>;

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

export const createSessionRequestSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("fast"),
    sessionName: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("focus"),
    objective: z.string().trim().min(1),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
  z.object({
    mode: z.literal("optimistic"),
    instructions: z.string().trim().min(1),
    images: z.array(imagePayloadSchema).max(5).optional(),
    tddEnabled: z.boolean().optional(),
    parentSessionName: z.string().trim().min(1).optional(),
  }),
]);
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;

export const sessionArchiveRequestSchema = z.object({
  archived: z.boolean(),
});

export const sessionTddRequestSchema = z.object({
  tddEnabled: z.boolean(),
});

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
});

export const finalizeInitResponseSchema = z.object({
  conversationId: z.string(),
  name: z.string(),
});
