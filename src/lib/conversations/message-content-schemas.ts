import { z } from "zod";

// Leaf module for message content-block schemas. It has no intra-domain
// imports, so both `schemas.ts` (conversation state, transcript, events) and
// `message-queue-schemas.ts` (durable queue entries) can depend on it without
// forming an import cycle.

export const toolResultMetricsSchema = z.object({
  lineCount: z.number().int().nonnegative().optional(),
  fileCount: z.number().int().nonnegative().optional(),
  matchCount: z.number().int().nonnegative().optional(),
  byteCount: z.number().int().nonnegative().optional(),
  exitCode: z.number().int().optional(),
});
export type ToolResultMetrics = z.infer<typeof toolResultMetricsSchema>;

// Forward reference: debugModePhaseSchema is defined in @/lib/debug-log/schemas.
// We inline its values here so messageContentBlockSchema can be defined first
// without a hoisting cycle.
const debugModePhaseLiterals = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "awaiting_verification",
  "cleanup_instrumentation",
]);

/**
 * One feedback line delivered to the agent and rendered in the transcript card.
 * `docPath` is the worktree-relative identity used to open the document; `path`
 * is the human-facing path embedded in the agent-facing prompt text. Defined
 * here (the leaf content-block module) rather than in `document-comments` so the
 * `document_feedback` block can reference it without forming an import cycle —
 * `document-comments/schemas` re-exports it as part of its domain surface.
 */
export const documentFeedbackItemSchema = z.object({
  docPath: z.string(),
  path: z.string(),
  headingLabel: z.string(),
  line: z.number().int().positive(),
  quote: z.string(),
  note: z.string(),
});
export type DocumentFeedbackItem = z.infer<typeof documentFeedbackItemSchema>;

/** The structured feedback payload threaded through the prompt/queue pipeline. */
export const documentFeedbackPayloadSchema = z.object({
  items: z.array(documentFeedbackItemSchema),
});
export type DocumentFeedbackPayload = z.infer<
  typeof documentFeedbackPayloadSchema
>;

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  // The agent's internal reasoning, surfaced separately from its answer text.
  // `text` is the model's thinking summary (Anthropic) or reasoning item
  // (Codex); empty when `redacted` is true (encrypted/opaque thinking the
  // provider won't reveal — rendered as a label-only indicator, never a body).
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    redacted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("tool_use"),
    id: z.string().optional(),
    name: z.string(),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    tool_use_id: z.string(),
    content: z.string().optional(),
    isError: z.boolean().optional(),
    metrics: toolResultMetricsSchema.optional(),
  }),
  z.object({
    type: z.literal("command"),
    name: z.string(),
    args: z.string().nullable(),
  }),
  z.object({
    type: z.literal("image"),
    mediaType: z.string(),
    base64Data: z.string(),
  }),
  z.object({
    type: z.literal("image_ref"),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
  z.object({
    type: z.literal("image_marker"),
    index: z.number().int().positive(),
    mediaType: z.string(),
    imagePath: z.string(),
  }),
  // Structured debug-mode output (hypothesis list, evidence analysis, fix
  // result, cleanup result). The payload shape varies per phase; the renderer
  // dispatches on `phase` and gracefully degrades when fields are missing
  // (e.g., Codex schema-divergent reply).
  z.object({
    type: z.literal("debug_structured"),
    phase: debugModePhaseLiterals,
    payload: z.unknown(),
  }),
  // Document review feedback delivered to the conversation: each item carries a
  // quoted passage, its source path + heading/line, and the user's note. Built
  // from a `documentFeedback` payload on the prompt/queue path and rendered as
  // the transcript's DocumentFeedbackCard.
  z.object({
    type: z.literal("document_feedback"),
    items: z.array(documentFeedbackItemSchema),
  }),
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;
