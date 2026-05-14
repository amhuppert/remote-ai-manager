/**
 * api-client.ts — Validated fetch helpers and response schemas.
 *
 * All API responses are validated at the boundary using Zod `parse()`.
 * This replaces the unsafe `res.json() as Promise<T>` pattern.
 */

import { z } from "zod";
import {
  sessionStateSchema,
  commitLogEntrySchema,
  messageContentBlockSchema,
  workflowDefinitionRecordSchema,
  workflowGeneratedDraftSchema,
  agentBackendSchema,
  globalConfigSchema,
  graphWorkflowCleanupStatusValueSchema,
  graphWorkflowHaltReasonSchema,
  graphWorkflowMergeStatusValueSchema,
  rawGlobalConfigSchema,
  resolvedWorkflowSemanticDefinitionSchema,
} from "@/lib/schemas";
import { tracedFetch } from "@/lib/traced-fetch";

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/** Error thrown when an API call fails. Carries optional structured fields. */
export class ApiCallError extends Error {
  readonly code?: string;
  readonly output?: string;

  constructor(message: string, code?: string, output?: string) {
    super(message);
    this.name = "ApiCallError";
    this.code = code;
    this.output = output;
  }
}

// ---------------------------------------------------------------------------
// Response schemas — API-boundary validation
// ---------------------------------------------------------------------------

// -- Project --
export const discoveredProjectSchema = z.object({
  name: z.string(),
  path: z.string(),
  activeSessions: z.number(),
  hasRunningSession: z.boolean(),
});

export const projectPreferencesResponseSchema = z.object({
  archived: z.array(z.string()),
  pinned: z.array(z.string()),
});

// -- Config --
export const configResponseSchema = z.object({
  baseDir: z.string(),
});

export const fullConfigResponseSchema = z.object({
  config: globalConfigSchema,
  raw: rawGlobalConfigSchema,
});
export type FullConfigResponse = z.infer<typeof fullConfigResponseSchema>;

// -- Sessions --
export const sessionsResponseSchema = z.object({
  sessions: z.array(sessionStateSchema),
});

// -- Diff --
const diffLineSchema = z.object({
  type: z.enum(["context", "add", "remove", "hunk-header"]),
  content: z.string(),
});

const diffHunkSchema = z.object({
  header: z.string(),
  lines: z.array(diffLineSchema),
});

const fileDiffSchema = z.object({
  filePath: z.string(),
  additions: z.number(),
  deletions: z.number(),
  hunks: z.array(diffHunkSchema),
});

export const sessionDiffSchema = z.object({
  files: z.array(fileDiffSchema),
  totalAdditions: z.number(),
  totalDeletions: z.number(),
});

// -- Commits --
export const commitsResponseSchema = z.object({
  commits: z.array(commitLogEntrySchema),
});

// -- Conversations --
export const activeConversationSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  status: z.enum(["new", "running", "awaiting", "waiting_for_input"]),
  lastActivityAt: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  agentBackend: agentBackendSchema,
});

export const activeGraphWorkflowContextMergeProgressSchema = z.object({
  contextId: z.string(),
  branchName: z.string().nullable(),
  mergeStatus: graphWorkflowMergeStatusValueSchema,
  cleanupStatus: graphWorkflowCleanupStatusValueSchema,
  lastMergeError: z.string().nullable(),
});

export const activeGraphWorkflowExecutionSchema = z.object({
  executionId: z.string(),
  status: z.enum([
    "pending",
    "running",
    "paused",
    "completed",
    "halted",
    "aborted",
  ]),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  activeContextIds: z.array(z.string()).default([]),
  activeContextTitles: z.array(z.string()).default([]),
  activeBatchIds: z.array(z.string()).default([]),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  contextMergeProgress: z
    .array(activeGraphWorkflowContextMergeProgressSchema)
    .default([]),
  completedContexts: z.number(),
  totalContexts: z.number(),
  startedAt: z.string(),
});

export const activeCollaborationExecutionSchema = z.object({
  workflowId: z.string(),
  status: z.enum(["running", "paused"]),
  phase: z.string(),
  projectName: z.string(),
  projectPath: z.string(),
  sessionName: z.string(),
  conversationId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const activeConversationsResponseSchema = z.object({
  conversations: z.array(activeConversationSchema),
  graphWorkflowExecutions: z
    .array(activeGraphWorkflowExecutionSchema)
    .default([]),
  activeCollaborationExecutions: z
    .array(activeCollaborationExecutionSchema)
    .default([]),
});

// -- Transcript --
export const transcriptMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.array(messageContentBlockSchema),
  timestamp: z.string().nullable(),
  model: z.string().optional(),
  effort: z.string().optional(),
});

// -- Content (focus doc, kiro doc file) --
export const contentResponseSchema = z.object({
  content: z.string(),
});

// -- Kiro doc tree --
export const kiroDocTreeSchema = z.object({
  steering: z.array(z.string()),
  specs: z.record(z.string(), z.array(z.string())),
});

// -- Presets --
export const presetInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  badge: z.string(),
  files: z.array(z.string()),
  installed: z.boolean(),
});

export const presetsResponseSchema = z.object({
  presets: z.array(presetInfoSchema),
});

export const statusResponseSchema = z.object({
  status: z.string(),
});

// -- Graph workflow definitions --
export const workflowDefinitionSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const workflowDefinitionsResponseSchema = z.object({
  items: z.array(workflowDefinitionSummarySchema),
});

export const workflowDefinitionMutationResponseSchema = z.object({
  item: workflowDefinitionRecordSchema,
});

export const workflowDefinitionGetResponseSchema = z.object({
  item: workflowDefinitionRecordSchema,
  resolved: resolvedWorkflowSemanticDefinitionSchema,
});

export const workflowGeneratedDraftResponseSchema =
  workflowGeneratedDraftSchema;

// -- Debug log stats --
export const debugLogStatsResponseSchema = z.object({
  entryCount: z.number(),
});

// -- Image count --
export const imageCountResponseSchema = z.object({
  count: z.number().int().nonnegative(),
});

// -- Collaboration --
export const collaborationEnvelopeSchema = z.object({
  workflowId: z.string(),
  workflowType: z.string(),
  status: z.enum(["running", "paused", "completed", "failed"]),
  phase: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
  errorSummary: z.string().optional(),
  pause: z
    .object({
      pauseKind: z.string(),
      gateKind: z.string(),
      resumeToken: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  featureSnapshot: z.unknown(),
});
export type CollaborationEnvelopeView = z.infer<
  typeof collaborationEnvelopeSchema
>;

export const collaborationListResponseSchema = z.object({
  envelopes: z.array(collaborationEnvelopeSchema),
});

export const collaborationStartResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("started"),
  statusUrl: z.string(),
});

export const collaborationResumeResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("resumed"),
});

export const collaborationStopResponseSchema = z.object({
  workflowId: z.string(),
  status: z.literal("stopped"),
});

// -- Session mutations --
export const finalizeInitResponseSchema = z.object({
  conversationId: z.string(),
  name: z.string(),
});

export const installPresetResponseSchema = z.object({
  installedFiles: z.array(z.string()),
  configUpdated: z.boolean(),
});

// ---------------------------------------------------------------------------
// Validated fetch — queries (GET)
// ---------------------------------------------------------------------------

/**
 * Fetch a GET endpoint and validate the response with a Zod schema.
 */
export async function apiFetch<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    throw new ApiCallError(
      (body as { error?: string }).error ?? `API error ${res.status}`,
    );
  }
  const data: unknown = await res.json();
  return schema.parse(data);
}

/**
 * Fetch a GET endpoint that returns null on 404.
 */
export async function apiFetchOptional<T>(
  url: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new ApiCallError(`Failed to fetch`);
  }
  const data: unknown = await res.json();
  return schema.parse(data);
}

// ---------------------------------------------------------------------------
// Validated fetch — mutations (POST/PUT/PATCH/DELETE)
// ---------------------------------------------------------------------------

/**
 * Fetch a mutation endpoint with tracing and validate the response.
 * When no schema is provided, the raw JSON is returned without validation.
 */
export async function mutationFetch<T>(
  url: string,
  traceLabel: string,
  options: RequestInit,
  schema?: z.ZodType<T>,
): Promise<T> {
  const res = await tracedFetch(url, traceLabel, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: "Request failed" }));
    const apiBody = body as { error?: string; code?: string; output?: string };
    throw new ApiCallError(
      apiBody.error ?? `API error ${res.status}`,
      apiBody.code,
      apiBody.output,
    );
  }
  const data: unknown = await res.json();
  return schema ? schema.parse(data) : (data as T);
}
