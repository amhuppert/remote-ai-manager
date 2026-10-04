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

/**
 * When a dependency is taken: a JSON-Schema-subset document the source's
 * accepted output must match, or the branch taken when no guarded sibling from
 * the same source matched. Evaluated only through output-schema-subset.ts.
 */
export const routeGuardSchema = z.union([
  z.object({ schema: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ else: z.literal(true) }).strict(),
]);
export type RouteGuard = z.infer<typeof routeGuardSchema>;

/** How many of a source's guarded routes must be taken. */
export const routeCardinalitySchema = z.enum([
  "independent",
  "atLeastOne",
  "exactlyOne",
]);

/** One context the run's definition may start, frozen at launch. */
export const runDefinitionContextSchema = z
  .object({
    key: z.string().min(1),
    /** Keys whose accepted results this context needs before it starts. */
    dependsOn: z.array(z.string().min(1)),
    /** Guards on some of those dependencies, by dependency key; the rest are always taken. */
    when: z.record(z.string(), routeGuardSchema).optional(),
    routing: z.object({ cardinality: routeCardinalitySchema }).strict().optional(),
    /** The resolved request; its inputs are bound from the dependencies at start. */
    request: contextStartRequestSchema,
  })
  .strict();
export type RunDefinitionContext = z.infer<typeof runDefinitionContextSchema>;

/**
 * A finite loop: its body runs again in fresh Contexts, the entry carrying the
 * exit results of recent passes, until the exit's accepted output matches
 * `until` or `maxPasses` passes ran. Work after the loop sees only the final
 * pass.
 */
export const runLoopSchema = z
  .object({
    key: z.string().min(1),
    body: z.array(z.string().min(1)).min(1),
    entry: z.string().min(1),
    exit: z.string().min(1),
    until: z.object({ schema: z.record(z.string(), z.unknown()) }).strict(),
    maxPasses: z.number().int().min(1),
  })
  .strict();
export type RunLoop = z.infer<typeof runLoopSchema>;

export const runFactsSchema = z
  .object({
    runId: z.string().min(1),
    kind: z.enum(["agent", "workflow"]),
    title: z.string().min(1),
    definition: z
      .object({
        revision: z.number().int().min(1),
        contexts: z.array(runDefinitionContextSchema).min(1),
        loops: z.array(runLoopSchema).optional(),
      })
      .strict(),
    /** The contexts started so far, in start order. */
    invocations: z.array(runInvocationSchema),
    control: z
      .object({
        paused: z.boolean(),
        cancelled: z.boolean(),
        /**
         * The Run itself could not be reconciled: its permit stays closed and
         * nothing new starts until the owner resumes it.
         */
        fault: z
          .object({ detail: z.string().min(1), at: z.string().min(1) })
          .strict()
          .nullable()
          .default(null),
      })
      .strict(),
  })
  .strict();
export type RunFacts = z.infer<typeof runFactsSchema>;

export const runProgressSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }).strict(),
  /** A person or the owner must act: a question, an approval or a halt. */
  z
    .object({ kind: z.literal("needs_owner"), reasons: z.array(z.string()) })
    .strict(),
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
export function boundaryDetail(
  boundary: Pick<RunBoundary, "detail">,
): Record<string, unknown> {
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
  .object({
    runId: z.string().min(1),
    contextIds: z.array(z.string().min(1)),
    progress: runProgressSchema,
  })
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
          /** Keys whose accepted results this context needs before it starts. */
          dependsOn: z.array(z.string()),
          /** Dependencies that have not succeeded yet. */
          waitingOn: z.array(z.string()),
          /** False until every dependency succeeded and the run started it. */
          started: z.boolean(),
          /** A route was not taken, so this context never runs. */
          skipped: z.boolean(),
          /** The loop this context belongs to, if any. */
          loop: z.string().nullable(),
          /** The pass this row shows, from 1; always 1 outside a loop. */
          pass: z.number().int().min(1),
          progress: contextProgressSchema.nullable(),
          /** Names the halt a disposition must clear; changes whenever progress does. */
          occurrence: z.string().nullable(),
          tasks: z.array(
            z
              .object({ id: z.string(), title: z.string(), status: z.string() })
              .strict(),
          ),
          /** assignment id → seat conversation id */
          seats: z.record(z.string(), z.string()),
          openQuestions: z.array(
            z
              .object({
                questionId: z.string(),
                seat: z.string(),
                text: z.string().nullable(),
              })
              .strict(),
          ),
          lastSummary: z.string().nullable(),
          output: z.unknown(),
        })
        .strict(),
    ),
    boundaries: z.array(
      z
        .object({
          seq: z.number().int(),
          kind: runBoundaryKindSchema,
          summary: z.string(),
          recordedAt: z.string(),
          notified: z.boolean(),
        })
        .strict(),
    ),
    /** Settled effects nothing has consumed yet; resume reconciles them. */
    stalled: z.array(z.string()),
    /** Routes and loops that cannot proceed until the definition changes. */
    halts: z.array(z.string()),
    loops: z.array(
      z
        .object({
          key: z.string(),
          /** The current pass, from 1; 0 before the loop starts. */
          pass: z.number().int().min(0),
          maxPasses: z.number().int(),
          state: z.enum([
            "unstarted",
            "skipped",
            "running",
            "next",
            "succeeded",
            "exhausted",
            "unevaluable",
          ]),
        })
        .strict(),
    ),
  })
  .strict();
export type RunView = z.infer<typeof runViewSchema>;

export const runControlResponseSchema = z
  .object({ ok: z.literal(true), progress: runProgressSchema.nullable() })
  .strict();
