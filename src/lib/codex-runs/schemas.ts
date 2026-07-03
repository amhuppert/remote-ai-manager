import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { codexReasoningEffortSchema } from "@/lib/agent-backends/schemas";

/**
 * Codex run job schemas (docs/design/cc-cli/02 §3.3).
 *
 * `run_codex` becomes a job: POST creates a run and returns its id; the run
 * executes server-side and outlives the initiating request; GET reports its
 * terminal state and results; cancel aborts a live run.
 */

export const codexRunStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "timed_out",
]);
export type CodexRunStatus = z.infer<typeof codexRunStatusSchema>;

/**
 * POST body — mirrors the `run_codex` tool input verbatim (`prompt`, `model`,
 * `reasoning_effort`) so a payload shaped like the old tool call carries over
 * with no silent field loss, plus the job-shaped extras the design calls out
 * (`timeoutMs`, `workingDirectory`, which defaults to the session worktree
 * server-side). The snake_case `reasoning_effort` intentionally matches the MCP
 * tool's input key.
 */
export const codexRunRequestSchema = z.object({
  prompt: z.string().trim().min(1),
  model: z.string().trim().min(1).optional(),
  reasoning_effort: codexReasoningEffortSchema.optional(),
  workingDirectory: z.string().trim().min(1).optional(),
  timeoutMs: z.number().int().positive().optional(),
});
export type CodexRunRequest = z.infer<typeof codexRunRequestSchema>;

export const codexReferenceDocumentSchema = z.object({
  filePath: z.string(),
  description: z.string(),
});
export type CodexReferenceDocument = z.infer<
  typeof codexReferenceDocumentSchema
>;

/**
 * Durable codex-run record — the SQLite-persisted bookkeeping shape (codex-runs
 * repo), mirroring the background-jobs history pattern. `summary` and
 * `referenceDocuments` populate on success; `error` on a failed/timed_out run;
 * `completedAt` on any terminal transition.
 */
export const codexRunRecordSchema = registerTrustedSchema(
  z.object({
    runId: z.string(),
    projectName: z.string(),
    sessionName: z.string(),
    status: codexRunStatusSchema,
    startedAt: z.string(),
    completedAt: z.string().optional(),
    summary: z.string().optional(),
    referenceDocuments: z.array(codexReferenceDocumentSchema).optional(),
    error: z.string().optional(),
  }),
  "codexRunRecordSchema",
);
export type CodexRunRecord = z.infer<typeof codexRunRecordSchema>;

/** POST response. */
export const codexRunCreatedResponseSchema = z.object({ runId: z.string() });

/**
 * GET response — the terminal (or in-progress) view of a run. `summary` and
 * `referenceDocuments` are present on success (mirroring the MCP tool's result
 * shape so downstream agent behavior is unchanged); `error` is present on a
 * failed/timed_out run.
 */
export const codexRunStatusResponseSchema = z.object({
  runId: z.string(),
  status: codexRunStatusSchema,
  summary: z.string().optional(),
  referenceDocuments: z.array(codexReferenceDocumentSchema).optional(),
  error: z.string().optional(),
});
export type CodexRunStatusResponse = z.infer<
  typeof codexRunStatusResponseSchema
>;
