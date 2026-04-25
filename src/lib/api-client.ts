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
  roadmapItemSchema,
  messageContentBlockSchema,
  workflowDefinitionRecordSchema,
  workflowGeneratedDraftSchema,
  agentBackendSchema,
  globalConfigSchema,
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
  activeContextTitle: z.string().nullable(),
  completedContexts: z.number(),
  totalContexts: z.number(),
  startedAt: z.string(),
});

export const activeConversationsResponseSchema = z.object({
  conversations: z.array(activeConversationSchema),
  graphWorkflowExecutions: z
    .array(activeGraphWorkflowExecutionSchema)
    .default([]),
});

// -- Transcript --
export const transcriptMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
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

// -- Roadmap items --
export const roadmapItemsResponseSchema = z.object({
  items: z.array(roadmapItemSchema),
});

export const roadmapItemMutationResponseSchema = z.object({
  item: roadmapItemSchema,
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
