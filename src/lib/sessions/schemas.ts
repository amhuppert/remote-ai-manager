import { z } from "zod";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { referenceDocumentSchema } from "@/lib/reference-documents/schemas";
import { mcpOverridesSchema } from "@/lib/mcp/schemas";
import { imagePayloadSchema } from "@/lib/images/schemas";
import { agentCapabilityOverridesSchema } from "@/lib/agent-capabilities/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "split" | "panes" | "diff";

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

export const sessionCreationModeSchema = z.enum(["normal", "optimistic"]);
export type SessionCreationMode = z.infer<typeof sessionCreationModeSchema>;

/**
 * Origin tag identifying a session created from a project conversation's spawn
 * card, with a back-reference to the spawning conversation. Always an object
 * when set; the field is nullable+optional on the session schema so legacy /
 * non-spawned session rows decode without it (the sessions repo provides an
 * explicit `null` on decode, mirroring how project conversations handle their
 * PLC-only `open` column).
 */
export const spawnedFromSchema = z.object({
  source: z.literal("chat"),
  projectName: z.string(),
  conversationId: z.string(),
});
export type SpawnedFrom = z.infer<typeof spawnedFromSchema>;

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
  derivedStatus: derivedSessionStatusSchema,
  promptCount: z.number().int().nonnegative(),
  derivedLastActivityAt: z.string(),
  collabContribution: z.enum(["running", "paused"]).nullable(),
  hasActiveGraphWorkflow: z.boolean(),
  // Surfaced so the slim list / passive status read can show the `from chat`
  // origin without a whole-state read. Nullable+optional like the state field.
  spawnedFrom: spawnedFromSchema.nullable().optional(),
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

export const createSessionRequestSchema = z
  .discriminatedUnion("mode", [
    z.object({
      mode: z.literal("normal"),
      sessionName: z.string().trim().min(1),
      tddEnabled: z.boolean().optional(),
      parentSessionName: z.string().trim().min(1).optional(),
    }),
    z.object({
      mode: z.literal("optimistic"),
      instructions: z.string().trim(),
      images: z.array(imagePayloadSchema).max(5).optional(),
      tddEnabled: z.boolean().optional(),
      parentSessionName: z.string().trim().min(1).optional(),
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

export const sessionTddRequestSchema = z.object({
  tddEnabled: z.boolean(),
});

export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionListItemSchema),
});

/**
 * The git branch prefix Command Center will actually apply when creating a
 * session in this project — the per-repo override, else the global default,
 * else `"csm"` (see `resolveBranchPrefix`). Surfaced so client surfaces (the New
 * Session dialog, the spawn card) can preview the real `<prefix>/<slug>` branch
 * instead of hardcoding a prefix.
 */
export const branchPrefixResponseSchema = z.object({
  branchPrefix: z.string(),
});
export type BranchPrefixResponse = z.infer<typeof branchPrefixResponseSchema>;
