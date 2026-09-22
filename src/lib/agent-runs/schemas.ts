import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";

/**
 * Agent run job schemas: a one-shot backend task run as a job. POST creates a
 * run and returns its id; the run executes server-side and outlives the
 * initiating request; GET reports its terminal state and results; cancel
 * aborts a live run. The backend is a request parameter — the executor is the
 * generic agent task runner.
 */

/**
 * Terminal vocabulary matches BackgroundJob's generic statuses
 * (running/completed/failed); a timed-out run is `failed` with the timeout in
 * `error`.
 */
export const agentRunStatusSchema = z.enum(["running", "completed", "failed"]);

/**
 * POST body. `backend` selects the task runner and is required — the server
 * never coerces a run onto a default backend.
 */
export const agentRunRequestSchema = z
  .object({
    backend: agentBackendSchema,
    prompt: z.string().trim().min(1),
    modelSelection: backendModelSelectionSchema.optional(),
    model: z
      .never({ error: "Use the complete modelSelection instead of model." })
      .optional(),
    reasoning_effort: z
      .never({ error: "Put reasoning effort in modelSelection.parameters." })
      .optional(),
    workingDirectory: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;

export const agentRunReferenceDocumentSchema = z.object({
  filePath: z.string(),
  description: z.string(),
});
export type AgentRunReferenceDocument = z.infer<
  typeof agentRunReferenceDocumentSchema
>;

/**
 * The run's output contract, validated through the shared structured-output
 * module (native payload → raw JSON → fenced JSON fall-through).
 */
export const agentRunOutputSchema = z.object({
  summary: z.string(),
  referenceDocuments: z.array(agentRunReferenceDocumentSchema),
});

/** Provider-neutral JSON Schema contract derived from {@link agentRunOutputSchema}. */
export const AGENT_RUN_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    referenceDocuments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          filePath: { type: "string" },
          description: { type: "string" },
        },
        required: ["filePath", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["summary", "referenceDocuments"],
  additionalProperties: false,
} as const;

/**
 * Durable agent-run record — the SQLite-persisted bookkeeping shape
 * (agent-runs repo), mirroring the background-jobs history pattern. `summary`
 * and `referenceDocuments` populate on completion; `error` on a failed run;
 * `completedAt` on any terminal transition.
 */
export const agentRunRecordSchema = registerTrustedSchema(
  z.object({
    runId: z.string(),
    backend: agentBackendSchema,
    projectName: z.string(),
    sessionName: z.string(),
    status: agentRunStatusSchema,
    startedAt: z.string(),
    completedAt: z.string().optional(),
    summary: z.string().optional(),
    referenceDocuments: z.array(agentRunReferenceDocumentSchema).optional(),
    error: z.string().optional(),
  }),
  "agentRunRecordSchema",
);
export type AgentRunRecord = z.infer<typeof agentRunRecordSchema>;

/** POST response. */
export const agentRunCreatedResponseSchema = z.object({ runId: z.string() });

/**
 * GET response — the terminal (or in-progress) view of a run. `summary` and
 * `referenceDocuments` are present on completion; `error` is present on a
 * failed run.
 */
export const agentRunStatusResponseSchema = z.object({
  runId: z.string(),
  backend: agentBackendSchema,
  status: agentRunStatusSchema,
  summary: z.string().optional(),
  referenceDocuments: z.array(agentRunReferenceDocumentSchema).optional(),
  error: z.string().optional(),
});
export type AgentRunStatusResponse = z.infer<
  typeof agentRunStatusResponseSchema
>;
