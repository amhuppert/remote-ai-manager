import { z } from "zod";

export const debugLogStatsResponseSchema = z.object({
  entryCount: z.number(),
});

// ============================================================
// Debug Mode Schemas
// ============================================================

export const debugHypothesisSchema = z.object({
  id: z.string(),
  description: z.string(),
  instrumentationPlan: z.string().optional(),
});
export type DebugHypothesis = z.infer<typeof debugHypothesisSchema>;

export const debugModePhaseSchema = z.enum([
  "hypothesizing",
  "awaiting_reproduction",
  "analyzing_evidence",
  "awaiting_verification",
  "cleanup_instrumentation",
]);
export type DebugModePhase = z.infer<typeof debugModePhaseSchema>;

export const debugModeStateSchema = z.object({
  active: z.boolean(),
  recording: z.boolean(),
  logFilePath: z.string(),
  enteredAt: z.string(),
  hypotheses: z.array(debugHypothesisSchema).default([]),
  reproductionSteps: z.array(z.string()).default([]),
  fixSummary: z.string().nullable().default(null),
  verificationSteps: z.array(z.string()).default([]),
  instructionsDelivered: z.boolean().default(false),
  phase: debugModePhaseSchema.default("hypothesizing"),
  lastTurnFailed: z.boolean().default(false),
});
export type DebugModeState = z.infer<typeof debugModeStateSchema>;

export const debugLogEntrySchema = z.object({
  timestamp: z.string(),
  hypothesisId: z.string().nullable().default(null),
  location: z.string().nullable().default(null),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type DebugLogEntry = z.infer<typeof debugLogEntrySchema>;

const debugProbeEntrySchema = z.object({
  id: z.string(),
  file: z.string(),
  description: z.string(),
});

export const debugInstrumentationManifestSchema = z.object({
  conversationId: z.string(),
  createdAt: z.string(),
  probes: z.array(debugProbeEntrySchema),
});
export type DebugInstrumentationManifest = z.infer<
  typeof debugInstrumentationManifestSchema
>;

// ============================================================
// Debug Mode API Request Schemas
// ============================================================

export const debugModeRequestSchema = z.object({
  action: z.enum([
    "enter",
    "exit",
    "mark_reproduced",
    "mark_fix_verified",
    "mark_fix_failed",
    "revert_to_awaiting_reproduction",
    "revert_to_awaiting_verification",
    "retry_turn",
  ]),
});

export const debugRecordingRequestSchema = z.object({
  recording: z.boolean(),
});

// ============================================================
// Debug Mode SSE Event Schemas
// ============================================================

export const debugModeStatusEventSchema = z.object({
  type: z.literal("debug-mode-status"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  active: z.boolean(),
  recording: z.boolean(),
});
export type DebugModeStatusEvent = z.infer<typeof debugModeStatusEventSchema>;

export const debugLogReceivedEventSchema = z.object({
  type: z.literal("debug-log-received"),
  projectName: z.string(),
  sessionName: z.string(),
  conversationId: z.string(),
  entryCount: z.number(),
});
export type DebugLogReceivedEvent = z.infer<typeof debugLogReceivedEventSchema>;
