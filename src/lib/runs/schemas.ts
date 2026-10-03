import { z } from "zod";
import {
  contextStartRequestSchema,
  contextProgressSchema,
  haltDispositionSchema,
} from "@/lib/execution-context/schemas";

/** One Context invocation a Run started: authored key, loop pass and identity. */
export const runInvocationSchema = z
  .object({
    key: z.string().min(1),
    pass: z.number().int().min(0),
    contextId: z.string().min(1),
    startCause: z.string().min(1),
    /** The frozen request the Run recorded to start it. */
    request: contextStartRequestSchema,
  })
  .strict();
export type RunInvocation = z.infer<typeof runInvocationSchema>;

export const runFactsSchema = z
  .object({
    runId: z.string().min(1),
    kind: z.enum(["agent", "workflow"]),
    title: z.string().min(1),
    invocations: z.array(runInvocationSchema),
    control: z
      .object({ paused: z.boolean(), cancelled: z.boolean() })
      .strict(),
  })
  .strict();
export type RunFacts = z.infer<typeof runFactsSchema>;

/** One invocation as the Run last observed it. */
export const invocationViewSchema = z
  .object({
    key: z.string(),
    contextId: z.string(),
    progress: contextProgressSchema.nullable(),
    occurrence: z.string().nullable(),
  })
  .strict();

export const runProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }).strict(),
  /** A person or the owner must act: a question, an approval or a halt. */
  z.object({ kind: z.literal("needs_owner"), reasons: z.array(z.string()) }).strict(),
  z.object({ kind: z.literal("paused"), draining: z.boolean() }).strict(),
  z.object({ kind: z.literal("stopping") }).strict(),
  z.object({ kind: z.literal("succeeded") }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
]);
export type RunProgress = z.infer<typeof runProgressSchema>;

export const runRecordSchema = z
  .object({
    runId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    ownerConversationId: z.string().min(1),
    /** The owner's scope: its session, or null for a project conversation. */
    ownerSessionName: z.string().min(1).nullable(),
    launchCause: z.string().min(1),
    facts: runFactsSchema,
    revision: z.number().int().min(1),
    progress: runProgressSchema,
    invocations: z.array(invocationViewSchema),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type RunRecord = z.infer<typeof runRecordSchema>;

export const runBoundaryKindSchema = z.enum([
  "question",
  "approval",
  "halted",
  "succeeded",
  "cancelled",
  "restored_paused",
]);
export type RunBoundaryKind = z.infer<typeof runBoundaryKindSchema>;

/** One owner-facing occurrence, keyed by its source occurrence so projection is idempotent. */
export const runBoundarySchema = z
  .object({
    seq: z.number().int().min(1),
    runId: z.string().min(1),
    occurrence: z.string().min(1),
    kind: runBoundaryKindSchema,
    summary: z.string().min(1),
    detail: z.unknown(),
    recordedAt: z.string().min(1),
    notifiedAt: z.string().min(1).nullable(),
  })
  .strict();
export type RunBoundary = z.infer<typeof runBoundarySchema>;

/** Reads a boundary's frozen detail as a field map; any other shape reads as empty. */
export function boundaryDetail(boundary: Pick<RunBoundary, "detail">): Record<string, unknown> {
  const parsed = z.record(z.string(), z.unknown()).safeParse(boundary.detail);
  return parsed.success ? parsed.data : {};
}

/** A disposition the owner passes to one Context's halt through the Run. */
export const runDispositionSchema = z
  .object({
    contextId: z.string().min(1),
    occurrence: z.string().min(1),
    disposition: haltDispositionSchema,
  })
  .strict();
export type RunDisposition = z.infer<typeof runDispositionSchema>;

// ---------------------------------------------------------------------------
// Agent-facing API responses
// ---------------------------------------------------------------------------

export const runLaunchedResponseSchema = z
  .object({ runId: z.string().min(1), contextIds: z.array(z.string().min(1)), progress: runProgressSchema })
  .strict();
export type RunLaunchedResponse = z.infer<typeof runLaunchedResponseSchema>;

/** One Run as its owner reads it: progress, each Context's state, and the boundary ledger. */
export const runViewSchema = z
  .object({
    runId: z.string(),
    title: z.string(),
    kind: z.enum(["agent", "workflow"]),
    progress: runProgressSchema,
    revision: z.number().int(),
    ownerConversationId: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    contexts: z.array(
      z
        .object({
          key: z.string(),
          contextId: z.string(),
          progress: contextProgressSchema.nullable(),
          /** Names the halt a disposition must clear; changes whenever progress does. */
          occurrence: z.string().nullable(),
          tasks: z.array(z.object({ id: z.string(), title: z.string(), status: z.string() }).strict()),
          /** assignment id → seat conversation id */
          seats: z.record(z.string(), z.string()),
          openQuestions: z.array(
            z.object({ questionId: z.string(), seat: z.string(), text: z.string().nullable() }).strict(),
          ),
          lastSummary: z.string().nullable(),
          output: z.unknown(),
        })
        .strict(),
    ),
    boundaries: z.array(
      z
        .object({ seq: z.number().int(), kind: runBoundaryKindSchema, summary: z.string(), recordedAt: z.string(), notified: z.boolean() })
        .strict(),
    ),
    /** Settled effects nothing has consumed yet; resume reconciles them. */
    stalled: z.array(z.string()),
  })
  .strict();
export type RunView = z.infer<typeof runViewSchema>;

export const runControlResponseSchema = z
  .object({ ok: z.literal(true), progress: runProgressSchema.nullable() })
  .strict();
