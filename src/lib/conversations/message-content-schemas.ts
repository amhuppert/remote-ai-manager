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

export const messageContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
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
]);
export type MessageContentBlock = z.infer<typeof messageContentBlockSchema>;
