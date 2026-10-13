import { z } from "zod";
import {
  laneProvisionReportSchema,
  lanePublicationReportSchema,
} from "@/lib/workspace/schemas";
import {
  contextStartRequestSchema,
  contextProgressSchema,
  contextViewSchema,
  haltDispositionSchema,
  haltKindSchema,
  seatSummarySchema,
} from "@/lib/execution-context/schemas";
import { sessionDiffSchema } from "@/lib/git/schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";

/** The charter revision and each document's revision a context froze when it started. */
export const runFrozenRevisionsSchema = z
  .object({
    charter: z.number().int().min(1).nullable(),
    documents: z.array(
      z
        .object({ path: z.string().min(1), revision: z.number().int().min(1) })
        .strict(),
    ),
  })
  .strict();

/** One Context invocation a Run started: authored key, loop pass and identity. */
export const runInvocationSchema = z
  .object({
    key: z.string().min(1),
    pass: z.number().int().min(0),
    contextId: z.string().min(1),
    startCause: z.string().min(1),
    /** Absent for a context started before runs recorded it. */
    froze: runFrozenRevisionsSchema.optional(),
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
    routing: z
      .object({ cardinality: routeCardinalitySchema })
      .strict()
      .optional(),
    /** Dependencies whose accepted output is enough: no code visibility, so no publication to wait for. */
    outputOnly: z.array(z.string().min(1)).optional(),
    /** The isolated lane this context works in; absent for session placement. */
    lane: z.string().min(1).optional(),
    /** The resolved request; its inputs are bound from the dependencies at start. */
    request: contextStartRequestSchema,
  })
  .strict();
export type RunDefinitionContext = z.infer<typeof runDefinitionContextSchema>;

/**
 * An isolated lane: its own worktree and branch, started from the session
 * branch's committed head once every lane it needs code from has published,
 * and published into the session branch once all its members are done.
 */
export const runLaneSchema = z
  .object({
    key: z.string().min(1),
    laneId: z.string().min(1),
    worktreePath: z.string().min(1),
    branch: z.string().min(1),
    /** Where the lane publishes: the session worktree and its branch. */
    target: z
      .object({ worktreePath: z.string().min(1), branch: z.string().min(1) })
      .strict(),
    /** Whole-tree checks run on the lane merged with the session head, before publication. */
    checks: z.array(z.string().min(1)),
  })
  .strict();
export type RunLane = z.infer<typeof runLaneSchema>;

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

/** Requested of Workspace and not answered yet. */
const requestedSchema = z.object({ kind: z.literal("requested") }).strict();
/** Withdrawn by cancelling the run before Workspace admitted it. */
const withdrawnSchema = z.object({ kind: z.literal("cancelled") }).strict();

/** Where a lane's worktree stands: requested, withdrawn, or what Workspace reported. */
export const laneProvisionOutcomeSchema = z.discriminatedUnion("kind", [
  requestedSchema,
  withdrawnSchema,
  ...laneProvisionReportSchema.options,
]);

/**
 * Where a lane's publication stands: requested, withdrawn, or what Workspace
 * reported. Anything but `published` halts until the owner asks for a new attempt.
 */
export const lanePublicationOutcomeSchema = z.discriminatedUnion("kind", [
  requestedSchema,
  withdrawnSchema,
  ...lanePublicationReportSchema.options,
]);
export type LanePublicationOutcome = z.infer<
  typeof lanePublicationOutcomeSchema
>;

export const runLaneStateSchema = z
  .object({
    provision: z
      .object({
        attempt: z.number().int().min(1),
        outcome: laneProvisionOutcomeSchema,
      })
      .strict(),
    publication: z
      .object({
        attempt: z.number().int().min(1),
        outcome: lanePublicationOutcomeSchema,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RunLaneState = z.infer<typeof runLaneStateSchema>;

/** A lane's state by its own key; a key such as `constructor` must not read an inherited property. */
export function laneStateOf(
  facts: Pick<RunFacts, "lanes">,
  key: string,
): RunLaneState | undefined {
  const lanes = facts.lanes;
  return lanes !== undefined && Object.hasOwn(lanes, key)
    ? lanes[key]
    : undefined;
}

/** A document as frozen for a run: its bytes by artifact, and what it is for. */
export const runDocumentSchema = z
  .object({
    path: z.string().min(1),
    artifactId: z.string().min(1),
    bytes: z.number().int().min(0),
    description: z.string().min(1),
    readWhen: z.string().min(1).optional(),
    /** The authored contexts it is for; every context when absent. */
    appliesTo: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type RunDocument = z.infer<typeof runDocumentSchema>;

/** One revision of a run document; a later revision of the same path supersedes it. */
export const runDocumentRevisionSchema = z
  .object({
    path: z.string().min(1),
    revision: z.number().int().min(1),
    source: z.enum(["launch", "amend", "publish"]),
    at: z.string().min(1),
    /** The context whose seat published it. */
    by: z.string().min(1).optional(),
    /** Why the owner amended the run, when they said. */
    reason: z.string().min(1).optional(),
    /** The document as of this revision; null when this revision removed it. */
    document: runDocumentSchema.omit({ path: true }).nullable(),
  })
  .strict();
export type RunDocumentRevision = z.infer<typeof runDocumentRevisionSchema>;

/**
 * A workflow's charter: its mission, the invariants every change must keep,
 * and its sources of truth ranked by authority (1 is highest). An invariant or
 * source may name the context keys it is for; it is for all of them otherwise.
 */
export const runCharterSchema = z
  .object({
    mission: z.string().trim().min(1),
    conventions: z.array(z.string().trim().min(1)).optional(),
    nonGoals: z.array(z.string().trim().min(1)).optional(),
    vocabulary: z.array(z.string().trim().min(1)).optional(),
    testStrategy: z.string().trim().min(1).optional(),
    knownAmbiguities: z.array(z.string().trim().min(1)).optional(),
    invariants: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            statement: z.string().trim().min(1),
            appliesTo: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    sourcesOfTruth: z
      .array(
        z
          .object({
            rank: z.number().int().positive(),
            id: z.string().trim().min(1),
            label: z.string().trim().min(1),
            type: z.enum(["code", "config", "document", "spec", "other"]),
            /** A path, glob or URI the agent reads itself; never resolved by CC. */
            locator: z.string().trim().min(1),
            description: z.string().trim().min(1),
            appliesTo: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict()
  .superRefine((charter, ctx) => {
    const ranks = new Map<number, string>();
    const sources = new Set<string>();
    charter.sourcesOfTruth?.forEach((source, index) => {
      const holder = ranks.get(source.rank);
      if (holder !== undefined)
        ctx.addIssue({
          code: "custom",
          path: ["sourcesOfTruth", index, "rank"],
          message: `Rank ${source.rank} is already source "${holder}"'s; each source needs its own rank`,
        });
      else ranks.set(source.rank, source.id);
      if (sources.has(source.id))
        ctx.addIssue({
          code: "custom",
          path: ["sourcesOfTruth", index, "id"],
          message: `Source id "${source.id}" is used twice`,
        });
      sources.add(source.id);
    });
    const invariants = new Set<string>();
    charter.invariants?.forEach((invariant, index) => {
      if (invariants.has(invariant.id))
        ctx.addIssue({
          code: "custom",
          path: ["invariants", index, "id"],
          message: `Invariant id "${invariant.id}" is used twice`,
        });
      invariants.add(invariant.id);
    });
  });
export type RunCharter = z.infer<typeof runCharterSchema>;

/** One revision of a run's charter and its frozen bundles; both null when this revision removed the charter. */
export const runCharterRevisionSchema = z
  .object({
    revision: z.number().int().min(1),
    source: z.enum(["launch", "amend"]),
    at: z.string().min(1),
    /** Why the owner amended it, when they said. */
    reason: z.string().min(1).nullable(),
    charter: runCharterSchema.nullable(),
    /** The rendered bundles as artifacts: one for every context no appliesTo names, one per key one names. */
    bundles: z
      .object({
        default: z.string().min(1),
        byKey: z.record(z.string(), z.string().min(1)),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RunCharterRevision = z.infer<typeof runCharterRevisionSchema>;

/** Who steers a run: the conversation that owns it, or a person in Command Center. */
export const runPrincipalSchema = z.enum(["owner", "person"]);
export type RunPrincipal = z.infer<typeof runPrincipalSchema>;

/** One pause, resume, cancel or lane retry the run applied, with who asked for it. */
export const runControlActSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("pause"),
      by: runPrincipalSchema,
      at: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("resume"),
      by: runPrincipalSchema,
      at: z.string().min(1),
      /** The halt dispositions the resume passed on, by kind. */
      dispositions: z.array(
        z
          .object({
            contextId: z.string().min(1),
            disposition: z.string().min(1),
          })
          .strict(),
      ),
    })
    .strict(),
  z
    .object({
      action: z.literal("cancel"),
      by: runPrincipalSchema,
      at: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("retry_lane"),
      by: runPrincipalSchema,
      at: z.string().min(1),
      lane: z.string().min(1),
    })
    .strict(),
]);
export type RunControlAct = z.infer<typeof runControlActSchema>;

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
        lanes: z.array(runLaneSchema).optional(),
        /**
         * The workflow as its owner wrote this revision, to read back, edit and
         * amend; its documents are kept as revisions instead, and read back from them.
         */
        authored: z.record(z.string(), z.unknown()).optional(),
      })
      .strict(),
    /** Every revision of the run's documents; a context freezes the latest that apply to it when it starts. */
    documents: z.array(runDocumentRevisionSchema).default([]),
    /** Every revision of the run's charter; a context freezes the latest when it starts. */
    charter: z.array(runCharterRevisionSchema).default([]),
    /** The contexts started so far, in start order. */
    invocations: z.array(runInvocationSchema),
    /** Each lane the Run asked Workspace to provision, by lane key. */
    lanes: z.record(z.string(), runLaneStateSchema).optional(),
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
    /** Every control act the run applied, in order. */
    acts: z.array(runControlActSchema).default([]),
    /** Each definition revision an amendment made: when, and why if the owner said. */
    amendments: z
      .array(
        z
          .object({
            revision: z.number().int().min(2),
            at: z.string().min(1),
            reason: z.string().min(1).nullable(),
          })
          .strict(),
      )
      .default([]),
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

/** Where a run template is stored: one project's library, or every project's. */
export const runTemplateTierSchema = z.enum(["project", "global"]);
export type RunTemplateTier = z.infer<typeof runTemplateTierSchema>;

/**
 * The saved template a run was launched from, as it stood then: the template
 * may change or go later, so its name is kept with the revision. Written once
 * at launch; an amendment keeps it.
 */
export const runOriginSchema = z
  .object({
    kind: z.literal("template"),
    tier: runTemplateTierSchema,
    id: z.string().min(1),
    revision: z.number().int().min(1),
    name: z.string().min(1),
  })
  .strict();
export type RunOrigin = z.infer<typeof runOriginSchema>;

export const runRecordSchema = z
  .object({
    runId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    ownerConversationId: z.string().min(1),
    /** The owner's scope: its session, or null for a project conversation. */
    ownerSessionName: z.string().min(1).nullable(),
    launchCause: z.string().min(1),
    /**
     * Its own column, never a key of `facts`: an older build parses facts
     * strictly and must still read the run after a rollback.
     */
    origin: runOriginSchema.nullable(),
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

/** A route, loop or lane that cannot proceed on its own. */
export const runHaltKindSchema = z.enum([
  "route_unevaluable",
  "route_cardinality",
  "loop_exhausted",
  "loop_unevaluable",
  "lane_provision",
  "lane_publication",
]);
export type RunHaltKind = z.infer<typeof runHaltKindSchema>;

/**
 * What clears a Run's own halt: a definition change, a new attempt for its
 * lane, or nothing short of cancelling (a started loop's unreadable exit).
 */
export const runHaltClearedBySchema = z.enum(["amend", "retry_lane", "cancel"]);
export type RunHaltClearedBy = z.infer<typeof runHaltClearedBySchema>;

/** What a boundary concerns, frozen when it is recorded: everything its notice needs. */
export const runBoundaryDetailSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("question"),
      contextId: z.string().min(1),
      questionId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("approval"),
      contextId: z.string().min(1),
      candidateId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("context_halt"),
      contextId: z.string().min(1),
      halt: z.string().min(1),
      occurrence: z.string().min(1),
      /** What clears it, as the Context named them when it halted. */
      dispositions: z.array(z.string().min(1)),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run_halt"),
      halt: runHaltKindSchema,
      clearedBy: runHaltClearedBySchema,
      lane: z.string().min(1).optional(),
      /** Other work goes on; a follow-up comes once only halts that need an amendment or cancelling remain. */
      otherWorkRemains: z.boolean(),
    })
    .strict(),
  /** The follow-up: only halts that need an amendment or cancelling remain. */
  z
    .object({
      kind: z.literal("stalled"),
      clearedBy: z.enum(["amend", "cancel"]),
    })
    .strict(),
  z.object({ kind: z.literal("fault"), error: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal("succeeded"),
      outputs: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
  z.object({ kind: z.literal("restored_paused") }).strict(),
]);
export type RunBoundaryDetail = z.infer<typeof runBoundaryDetailSchema>;

/** One owner-facing occurrence, keyed by its source occurrence so projection is idempotent. */
export const runBoundarySchema = z
  .object({
    seq: z.number().int().min(1),
    runId: z.string().min(1),
    occurrence: z.string().min(1),
    kind: runBoundaryKindSchema,
    summary: z.string().min(1),
    detail: runBoundaryDetailSchema,
    recordedAt: z.string().min(1),
  })
  .strict();
export type RunBoundary = z.infer<typeof runBoundarySchema>;

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

/** Where a lane stands for its owner. */
export const runLaneStatusSchema = z.enum([
  "waiting",
  "skipped",
  "cancelled",
  "provisioning",
  "provision_failed",
  "working",
  "publishing",
  "published",
  "blocked",
  "stale",
  "failed",
  "uncertain",
]);

/** Where a loop stands for its owner. */
export const runLoopStatusSchema = z.enum([
  "unstarted",
  "skipped",
  "running",
  "next",
  "succeeded",
  "exhausted",
  "unevaluable",
]);

/** One Run as its owner reads it: progress, each Context's state, and the boundary ledger. */
export const runViewSchema = z
  .object({
    runId: z.string(),
    title: z.string(),
    kind: z.enum(["agent", "workflow"]),
    progress: runProgressSchema,
    revision: z.number().int(),
    /** The definition revision in force: what an amendment is based on. */
    definitionRevision: z.number().int().min(1),
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
          /** The isolated lane it works in; null for the session worktree. */
          lane: z.string().nullable(),
          /** Its own lane, still to be provisioned before it can start. */
          waitingOnLaneProvision: z.string().nullable(),
          /** Lanes whose publication it waits for. */
          waitingOnPublications: z.array(z.string()),
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
          /** What it froze when it started; null before it starts. */
          froze: runFrozenRevisionsSchema.nullable(),
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
        })
        .strict(),
    ),
    /** Who paused, resumed, cancelled or retried the run, in order. */
    acts: z.array(runControlActSchema),
    /** Settled effects nothing has consumed yet; resume reconciles them. */
    stalled: z.array(z.string()),
    /** Routes and loops that cannot proceed until the definition changes. */
    halts: z.array(z.string()),
    lanes: z.array(
      z
        .object({
          key: z.string(),
          worktreePath: z.string(),
          branch: z.string(),
          state: runLaneStatusSchema,
          /** The current provisioning or publication attempt, from 1. */
          attempt: z.number().int().nullable(),
          /** Why it stopped, or where the session head moved. */
          detail: z.string().nullable(),
          /** The commit publication put on the session branch. */
          commit: z.string().nullable(),
        })
        .strict(),
    ),
    loops: z.array(
      z
        .object({
          key: z.string(),
          /** The current pass, from 1; 0 before the loop starts. */
          pass: z.number().int().min(0),
          maxPasses: z.number().int(),
          state: runLoopStatusSchema,
        })
        .strict(),
    ),
    /** The run's current documents: what a context starting now would freeze. */
    documents: z.array(
      z
        .object({
          path: z.string(),
          revision: z.number().int().min(1),
          /** How this revision came: declared at launch, by an amendment, or published by a context's seat. */
          source: z.enum(["launch", "amend", "publish"]),
          by: z.string().optional(),
          reason: z.string().optional(),
          bytes: z.number().int().min(0),
          description: z.string(),
          readWhen: z.string().optional(),
          appliesTo: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    /** The charter a context starting now would freeze, by revision; null for a run without one. */
    charter: z
      .object({
        revision: z.number().int().min(1),
        mission: z.string(),
        reason: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type RunView = z.infer<typeof runViewSchema>;

export const runDefinitionResponseSchema = z
  .object({
    runId: z.string().min(1),
    revision: z.number().int().min(1),
    /** The workflow as its owner wrote the current revision; null for an agent run. */
    definition: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();

export const runAmendedResponseSchema = z
  .object({
    ok: z.literal(true),
    /** The definition revision the amendment made. */
    revision: z.number().int().min(1),
    progress: runProgressSchema.nullable(),
    /** Routes and loops that still cannot proceed under it. */
    halts: z.array(z.string()),
    /** Documents the amendment left out, so work that starts from now no longer reads them. */
    removedDocuments: z.array(z.string()),
  })
  .strict();
export type RunAmendedResponse = z.infer<typeof runAmendedResponseSchema>;

export const runDocumentPublishedResponseSchema = z
  .object({
    ok: z.literal(true),
    runId: z.string().min(1),
    path: z.string().min(1),
    revision: z.number().int().min(1),
    /** The same bytes and description as the latest revision: nothing new was recorded. */
    unchanged: z.boolean(),
  })
  .strict();

export const runControlResponseSchema = z
  .object({ ok: z.literal(true), progress: runProgressSchema.nullable() })
  .strict();

// ---------------------------------------------------------------------------
// Run page: the run as the person reads it in Command Center (design §9,
// amendment 17); src/features/runs renders these.
// ---------------------------------------------------------------------------

/** A run's progress, as shown. */
export const runStatusSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running") }).strict(),
  z.object({ kind: z.literal("needs_input") }).strict(),
  z.object({ kind: z.literal("paused"), draining: z.boolean() }).strict(),
  z.object({ kind: z.literal("stopping") }).strict(),
  z.object({ kind: z.literal("succeeded") }).strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runOwnerSchema = z
  .object({
    conversationId: z.string().min(1),
    /** Its name or summary; null when it has neither, or is gone from the session. */
    title: z.string().nullable(),
    /** Null once the owner conversation is gone from the session. */
    backend: agentBackendSchema.nullable(),
  })
  .strict();

/** A row in the session's run list. */
export const runSummarySchema = z
  .object({
    runId: z.string().min(1),
    title: z.string(),
    kind: z.enum(["agent", "workflow"]),
    status: runStatusSchema,
    /** Approvals, halts and lane stops a person can act on. */
    attention: z.number().int().min(0),
    contexts: z
      .object({ done: z.number().int(), total: z.number().int() })
      .strict(),
    costUsd: z.number(),
    /** False when a seat's conversation is gone, so costUsd counts only the rest. */
    costComplete: z.boolean(),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).nullable(),
    owner: runOwnerSchema,
  })
  .strict();
export type RunSummary = z.infer<typeof runSummarySchema>;

/** A current run, across every session, as the sidebar and the "Needs you" menu read it. */
export const activeRunSchema = runSummarySchema
  .pick({
    runId: true,
    title: true,
    kind: true,
    status: true,
    attention: true,
    contexts: true,
    startedAt: true,
  })
  .extend({
    projectName: z.string().min(1),
    sessionName: z.string().min(1),
    /** Results awaiting a person's approval, among `attention`. */
    approvals: z.number().int().min(0),
    /** When the newest of what needs a person arose; null when nothing does, or nothing dated does. */
    askedAt: z.string().min(1).nullable(),
  })
  .strict();
export type ActiveRun = z.infer<typeof activeRunSchema>;

/** One conversation a context's seat held, replaced incarnations included. */
export const seatConversationSchema = z
  .object({
    conversationId: z.string().min(1),
    assignment: z.string().min(1),
    seat: seatSummarySchema.nullable(),
    status: z.enum(["active", "idle", "replaced", "finished"]),
    /** Null once the conversation is gone from the session: what it spent is no longer known. */
    turns: z.number().int().min(0).nullable(),
    costUsd: z.number().nullable(),
  })
  .strict();

export const frozenDocumentSchema = z
  .object({
    path: z.string().min(1),
    revision: z.number().int().min(1),
    /** How the run's current declaration differs from what this invocation froze. */
    later: z.enum(["superseded", "removed"]).nullable(),
  })
  .strict();

/** One context key's invocation: what its Context shows, with what only the Run knows. */
export const contextInvocationSchema = contextViewSchema
  .pick({
    title: true,
    brief: true,
    state: true,
    stages: true,
    tasks: true,
    taskList: true,
    criteria: true,
    implementer: true,
    reviewers: true,
    humanApproval: true,
    questions: true,
    reviews: true,
    output: true,
    inputs: true,
    approval: true,
    decisions: true,
    lastSummary: true,
    configuration: true,
  })
  .extend({
    key: z.string().min(1),
    placement: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("session") }).strict(),
      z.object({ kind: z.literal("lane"), lane: z.string().min(1) }).strict(),
    ]),
    loop: z
      .object({
        key: z.string().min(1),
        pass: z.number().int().min(1),
        maxPasses: z.number().int().min(1),
      })
      .strict()
      .nullable(),
    dependsOn: z.array(z.string()),
    /** What its seats' conversations cost; null before it started. */
    costUsd: z.number().nullable(),
    /** False when a seat's conversation is gone, so costUsd counts only the rest. */
    costComplete: z.boolean(),
    startedAt: z.string().min(1).nullable(),
    /** The started Context's id; null before it started. */
    invocationId: z.string().min(1).nullable(),
    agents: z.array(seatConversationSchema),
    froze: z
      .object({
        charter: z.number().int().min(1).nullable(),
        documents: z.array(frozenDocumentSchema),
      })
      .strict()
      .nullable(),
    /** What the candidate awaiting approval changed, or why that cannot be shown; null when nothing awaits. */
    candidate: z
      .discriminatedUnion("status", [
        z
          .object({
            status: z.literal("ready"),
            scope: z.enum(["whole_tree", "owned"]),
            ownedPaths: z.array(z.string()),
            diff: sessionDiffSchema,
          })
          .strict(),
        z
          .object({ status: z.literal("unavailable"), reason: z.string() })
          .strict(),
      ])
      .nullable(),
  })
  .strict();
export type ContextInvocation = z.infer<typeof contextInvocationSchema>;

export const contextDetailSchema = contextInvocationSchema
  .extend({
    /** Earlier loop passes of this key, oldest first. */
    previousInvocations: z.array(contextInvocationSchema),
  })
  .strict();
export type ContextDetail = z.infer<typeof contextDetailSchema>;

export const runEdgeSchema = z
  .object({
    from: z.string().min(1),
    to: z.string().min(1),
    guard: z
      .object({
        label: z.string(),
        state: z.enum(["taken", "not_taken", "undecided"]),
      })
      .strict()
      .nullable(),
    outputOnly: z.boolean(),
  })
  .strict();

export const runPageLaneSchema = z
  .object({
    key: z.string().min(1),
    branch: z.string(),
    worktreePath: z.string(),
    state: runLaneStatusSchema,
    attempt: z.number().int().nullable(),
    detail: z.string().nullable(),
    commit: z.string().nullable(),
    checks: z.array(z.string()),
  })
  .strict();

export const runPageLoopSchema = z
  .object({
    key: z.string().min(1),
    body: z.array(z.string()),
    pass: z.number().int().min(0),
    maxPasses: z.number().int(),
    state: runLoopStatusSchema,
    /** The exit condition, as its schema reads. */
    until: z.string(),
  })
  .strict();

export const runPageDocumentSchema = z
  .object({
    path: z.string().min(1),
    revision: z.number().int().min(1),
    source: z.enum(["launch", "amend", "publish"]),
    by: z.string().optional(),
    reason: z.string().optional(),
    description: z.string(),
    readWhen: z.string().optional(),
    appliesTo: z.array(z.string()).optional(),
    bytes: z.number().int().min(0),
    at: z.string().min(1),
    contents: z.string(),
  })
  .strict();

export const runPageCharterSchema = z
  .object({
    revision: z.number().int().min(1),
    source: z.enum(["launch", "amend"]),
    at: z.string().min(1),
    reason: z.string().nullable(),
    mission: z.string(),
    conventions: z.array(z.string()),
    vocabulary: z.array(z.string()),
    testStrategy: z.string().nullable(),
    knownAmbiguities: z.array(z.string()),
    invariants: z.array(
      z
        .object({
          id: z.string(),
          statement: z.string(),
          appliesTo: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    /** Sources of truth, highest authority (rank 1) first. */
    sources: z.array(
      z
        .object({
          rank: z.number().int(),
          label: z.string(),
          locator: z.string(),
          description: z.string(),
          appliesTo: z.array(z.string()).optional(),
        })
        .strict(),
    ),
    nonGoals: z.array(z.string()),
  })
  .strict();

export const activityEventSchema = z
  .object({
    /** Which fact the event comes from; stable while that fact stands. */
    id: z.string().min(1),
    /** Its position in the run's activity, oldest first, from 1; not an identity. */
    seq: z.number().int().min(1),
    at: z.string().min(1),
    kind: z.enum([
      "launched",
      "started",
      "question",
      "answered",
      "halted",
      "resolved",
      "approval",
      "decided",
      "published",
      "amended",
      "succeeded",
      "paused",
      "resumed",
      "retried",
      "cancelled",
    ]),
    summary: z.string(),
    contextKey: z.string().optional(),
  })
  .strict();

/** What needs a person, or the owner, now. */
export const attentionItemSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("approval"),
      contextKey: z.string(),
      contextTitle: z.string(),
      requestedAt: z.string(),
      reviewersPassed: z.number().int().min(0),
    })
    .strict(),
  z
    .object({
      kind: z.literal("halt"),
      contextKey: z.string(),
      contextTitle: z.string(),
      halt: haltKindSchema,
      detail: z.string(),
      at: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("run_halt"),
      occurrence: z.string(),
      halt: z.enum([...runHaltKindSchema.options, "reconcile_failed"]),
      detail: z.string(),
      clearedBy: z.enum(["amend", "retry_lane", "cancel", "resume"]),
      lane: z.string().optional(),
      at: z.string(),
    })
    .strict(),
  /** A settled effect nothing consumed; a resume reconciles it (design r2 §3.4). */
  z
    .object({
      kind: z.literal("stalled"),
      contextKey: z.string().optional(),
      contextTitle: z.string().optional(),
      causes: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("question"),
      questionId: z.string(),
      contextKey: z.string(),
      contextTitle: z.string(),
      seat: z.string(),
      question: z.string(),
      askedAt: z.string(),
    })
    .strict(),
]);

export const runPageSchema = z
  .object({
    runId: z.string().min(1),
    title: z.string(),
    kind: z.enum(["agent", "workflow"]),
    status: runStatusSchema,
    owner: runOwnerSchema,
    /** The template it was launched from; null when its owner launched it directly. */
    origin: runOriginSchema.nullable(),
    definitionRevision: z.number().int().min(1),
    startedAt: z.string().min(1),
    finishedAt: z.string().min(1).nullable(),
    costUsd: z.number(),
    /** False when a seat's conversation is gone, so costUsd counts only the rest. */
    costComplete: z.boolean(),
    attention: z.array(attentionItemSchema),
    contexts: z.array(contextDetailSchema),
    edges: z.array(runEdgeSchema),
    lanes: z.array(runPageLaneSchema),
    loops: z.array(runPageLoopSchema),
    documents: z.array(runPageDocumentSchema),
    documentHistory: z.array(runPageDocumentSchema),
    charter: runPageCharterSchema.nullable(),
    charterHistory: z.array(runPageCharterSchema),
    activity: z.array(activityEventSchema),
    /** The workflow as its owner wrote it, with the current documents; null for an agent run. */
    definition: z.record(z.string(), z.unknown()).nullable(),
  })
  .strict();
export type RunPage = z.infer<typeof runPageSchema>;

/** A pause, resume (with the halt dispositions it passes on), cancel or lane retry, as sent by the owner or a person. */
export const runControlRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("pause") }).strict(),
  z
    .object({
      action: z.literal("resume"),
      dispositions: z
        .array(
          z
            .object({
              contextId: z.string().min(1),
              occurrence: z.string().min(1),
              disposition: haltDispositionSchema,
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("cancel") }).strict(),
  z.object({ action: z.literal("retry"), lane: z.string().min(1) }).strict(),
]);
export type RunControlRequest = z.infer<typeof runControlRequestSchema>;

/** A person's decision on a result awaiting human approval. */
export const runDecisionRequestSchema = z
  .object({
    contextId: z.string().min(1),
    candidateId: z.string().min(1),
    decision: z.enum(["approved", "rejected"]),
    notes: z.string().min(1).optional(),
  })
  .strict();
export type RunDecisionRequest = z.infer<typeof runDecisionRequestSchema>;

export const runDecisionResponseSchema = z
  .object({ ok: z.literal(true) })
  .strict();
