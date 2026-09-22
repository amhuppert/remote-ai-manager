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
  /**
   * Stable identity for one enter-to-exit debug session. Cleanup verification
   * results carry this identity in addition to their per-session attempt so a
   * late result from an earlier session cannot affect a re-entered session.
   */
  debugSessionId: z.string().min(1).optional(),
  /**
   * Monotonic count of cleanup verifications started this debug session
   * (absent = 0). Each async verification result is stamped with the attempt
   * that started it, so a superseded attempt's late result is ignored instead
   * of exiting debug mode or failing the current attempt.
   */
  cleanupVerificationAttempt: z.number().int().nonnegative().optional(),
});
export type DebugModeState = z.infer<typeof debugModeStateSchema>;

/**
 * Debug state after the persistence-boundary legacy upgrade has completed.
 * Runtime reducers require this shape so every async cleanup result can be
 * matched to one concrete enter-to-exit debug session.
 */
export type RuntimeDebugModeState = DebugModeState & {
  debugSessionId: string;
};

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
  // Non-empty: the lifecycle projection uses conversationId as the StatusBus
  // scopeId, which the envelope schema requires to be non-empty.
  conversationId: z.string().min(1),
  active: z.boolean(),
  recording: z.boolean(),
});
export type DebugModeStatusEvent = z.infer<typeof debugModeStatusEventSchema>;

export const debugLogReceivedEventSchema = z.object({
  type: z.literal("debug-log-received"),
  projectName: z.string(),
  sessionName: z.string(),
  // Non-empty: the lifecycle projection uses conversationId as the StatusBus
  // scopeId, which the envelope schema requires to be non-empty.
  conversationId: z.string().min(1),
  entryCount: z.number(),
});
export type DebugLogReceivedEvent = z.infer<typeof debugLogReceivedEventSchema>;
