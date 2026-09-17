import { z } from "zod";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { backendModelSelectionSchema } from "@/lib/agent-backends/schemas";
import {
  graphWorkflowStatusSchema,
  graphWorkflowContextStatusSchema,
  graphWorkflowTaskStatusSchema,
  graphWorkflowResolvedContextSchema,
} from "./definition-schemas";
import {
  validatorAssignmentSchema,
  graphWorkflowCommandSelectorSchema,
  graphWorkflowLaneMergeValidationConfigSchema,
} from "./config-schemas";
import {
  graphWorkflowLoopStateSchema,
  graphWorkflowContextSkipReasonSchema,
  graphWorkflowRouteEdgeEvaluationSchema,
} from "./schemas";
import { resolvedCollaborationConfigSchema } from "./collaboration-schemas";
import { charterAmendmentSchema } from "@/lib/workflows/charter-schemas";
import { agentCallStructuredOutputParseSchema } from "@/lib/workflows/primitives/agent-call-vocabulary";

// Read contracts accept unknown fields alongside the declared response fields.
// Missing navigation annotations retain their declared defaults. Assignment
// provenance and cohort enablement remain required: readers cannot infer them.

/**
 * Both halves are optional because the annotation is cosmetic. If a renamed
 * field made the row fail to parse, the whole outline would fall back to JSON
 * over a decoration. A shape with neither field still reports a declaration.
 */
export const outputSchemaShapeSchema = z
  .object({ type: z.string().nullish(), fieldCount: z.number().nullish() })
  .loose();
const outlineSkipReasonSchema = graphWorkflowContextSkipReasonSchema
  .extend({
    at: z.string(),
    edgeEvaluations: z.array(
      graphWorkflowRouteEdgeEvaluationSchema
        .extend({
          edgeId: z.string(),
          verdict: graphWorkflowRouteEdgeEvaluationSchema.shape.verdict,
        })
        .loose(),
    ),
  })
  .loose();
const outlineLoopMembershipSchema = z
  .object({
    loopGroupId: z.string(),
    pass: z.number(),
    maxPasses: z.number(),
    activation: graphWorkflowLoopStateSchema.shape.activation,
    templateVersion: z.number().nullish(),
    passCount: z.number().optional(),
    authoredContextId: z.string().optional(),
  })
  .loose();
const outlineCaptureParseSchema = agentCallStructuredOutputParseSchema
  .extend({
    source: agentCallStructuredOutputParseSchema.shape.source,
    repairAttempts: agentCallStructuredOutputParseSchema.shape.repairAttempts,
  })
  .loose();

/** The three editability tiers a context row can carry (doc 06 outline column). */
export const liveOutlineEditabilitySchema = z.enum([
  "frozen",
  "editable",
  "pause-to-edit",
]);
export type LiveOutlineEditability = z.infer<
  typeof liveOutlineEditabilitySchema
>;

export const liveOutlineHeaderSchema = z
  .object({
    executionId: z.string(),

    liveRevision: z.number(),

    status: graphWorkflowStatusSchema,

    seedDefinitionId: z.string().nullable(),

    seedDefinitionRevision: z.number().nullable(),
    /**
     * Whether the execution accepts live edits at all. A terminal/non-resumable
     * execution surfaces its read-only-ness HERE (doc 06: "not-editable … shown in
     * the header line instead"), so the per-context `editability` tier stays one of
     * the three lifecycle-derived values and the header is the authoritative gate.
     */
    editable: z.boolean(),

    notEditableReason: z.string().optional(),
    /** Accepted live charter amendments so far (doc 07); 0 for pre-field rows. */
    charterAmendmentCount: z.number().default(0),
    /** Plan-repair rounds run so far (docs/design/cc-cli/08); 0 for pre-D1 rows. */
    planRepairRoundCount: z.number().default(0),
    /**
     * The round whose repair agent has not reported yet, or null.
     *
     * The count alone cannot answer the question a reader of a HALTED run has:
     * a repair mid-turn and one that gave up long ago present identically —
     * same status, same halt reason, same count — and they call for opposite
     * actions. `startedAt` is included because the turn is bounded, so how long
     * the round has been open is what says whether the agent can still be there;
     * `conversationId` is the transcript that settles the question outright.
     */
    openPlanRepairRound: z
      .union([
        z
          .object({
            seq: z.number(),

            contextId: z.string(),

            startedAt: z.string(),

            conversationId: z.union([z.string(), z.null()]).optional(),
          })
          .loose(),
        z.null(),
      ])
      .optional(),
  })
  .loose();
export type LiveOutlineHeader = z.infer<typeof liveOutlineHeaderSchema>;

export const liveOutlineAgentSummarySchema = z
  .object({
    backend: agentBackendSchema,

    modelSelection: backendModelSelectionSchema,
  })
  .loose();
export type LiveOutlineAgentSummary = z.infer<
  typeof liveOutlineAgentSummarySchema
>;

/**
 * The provenance of a SEEDED assignment: which profile revision execution start
 * resolved, and the hash of the instruction block the lane actually replays.
 *
 * These two fields are what separates a live execution's staffing from a saved
 * definition's. A saved document names a reference the library still owns and
 * can still change; a running execution replays bytes nothing can reach. The
 * instruction text behind the hash is deliberately absent — an outline is a
 * navigation surface, and the hash is the whole point of provenance here.
 */
export const liveOutlineAssignmentProvenanceSchema = z
  .object({
    /** The assignment's stable use-site id, unique within its cohort. */
    assignmentId: z.string(),
    /** The library profile, in the compact `tier:id` spelling. */
    profile: z.string(),
    /** The use-site steer narrowing the profile, when one was authored. */
    focus: z.union([z.string(), z.null()]),
    /** The profile revision resolved at execution start. */
    revision: z.number(),
    /** Hash of the rendered instruction block the lane replays verbatim. */
    resolvedInstructionHash: z.string(),
  })
  .loose();
export type LiveOutlineAssignmentProvenance = z.infer<
  typeof liveOutlineAssignmentProvenanceSchema
>;

export const liveOutlineImplementerSummarySchema =
  liveOutlineAgentSummarySchema.extend(
    liveOutlineAssignmentProvenanceSchema.shape,
  );
export type LiveOutlineImplementerSummary = z.infer<
  typeof liveOutlineImplementerSummarySchema
>;

export const liveOutlineValidatorSummarySchema = z
  .object({
    strategy: validatorAssignmentSchema.out.shape.strategy,
  })
  .loose()
  .extend(liveOutlineAssignmentProvenanceSchema.shape)
  .extend(liveOutlineAgentSummarySchema.shape);
export type LiveOutlineValidatorSummary = z.infer<
  typeof liveOutlineValidatorSummarySchema
>;

export const liveOutlineCollaborationSummarySchema = z
  .object({
    secondAgent: liveOutlineAgentSummarySchema,

    negotiationRounds: z.number(),

    autonomousResolutionThreshold: z.string(),
  })
  .loose();
export type LiveOutlineCollaborationSummary = z.infer<
  typeof liveOutlineCollaborationSummarySchema
>;

export const liveOutlineScriptValidatorSummarySchema = z
  .object({
    commands: z.array(z.string()),
  })
  .loose();
export type LiveOutlineScriptValidatorSummary = z.infer<
  typeof liveOutlineScriptValidatorSummarySchema
>;

/** The concrete per-role command selections from the seed-time snapshot. */
export const liveOutlineAgentValidationSummarySchema = z
  .object({
    implementer: graphWorkflowCommandSelectorSchema,

    contextValidator: graphWorkflowCommandSelectorSchema,
  })
  .loose();
export type LiveOutlineAgentValidationSummary = z.infer<
  typeof liveOutlineAgentValidationSummarySchema
>;

export const liveOutlineContextConfigSchema = z
  .object({
    contextId: z.string(),

    implementer: liveOutlineImplementerSummarySchema,
    /**
     * False when the cohort is switched off. Dormancy is a property of the
     * COHORT, not of an assignment — every assignment below is dormant when this
     * is false, and none of them is dispatched.
     */
    validatorCohortEnabled: z.boolean(),
    /**
     * Every seeded assignment, dormant ones included. A disabled cohort retains
     * its assignments and start snapshotted them, so this is what the execution
     * actually holds — omitting them would make re-enabling one a blind edit.
     */
    validators: z.array(liveOutlineValidatorSummarySchema),

    scriptValidator: liveOutlineScriptValidatorSummarySchema,

    humanApprovalGate: z.boolean(),

    askUserQuestions: z.boolean(),
    /** `null` when no resolved collaboration snapshot exists (legacy executions). */
    collaboration: z
      .union([liveOutlineCollaborationSummarySchema, z.null()])
      .optional(),
    /** `null` when no selector snapshot exists (pre-snapshot executions). */
    agentValidation: z
      .union([liveOutlineAgentValidationSummarySchema, z.null()])
      .optional(),
  })
  .loose();
export type LiveOutlineContextConfig = z.infer<
  typeof liveOutlineContextConfigSchema
>;

/**
 * A context's FULL resolved config — the concrete runtime values a `live edit`
 * addresses (doc 06: selector responses return full config, not the compact
 * outline summary). Every block is the exact resolved shape from
 * `workingDefinition`, so the inspector/agent can inspect and edit concrete
 * values (implementer, validator, script/approval/questions gates, iteration
 * policy, circuit breaker, mutability, collaboration). Kept in lockstep with
 * `graphWorkflowResolvedContextSchema` via the schema pick so a new resolved-config field
 * surfaces here without drift.
 */
// outputSchema is context identity, included for the config read-back.
// Collaboration is null when no resolved snapshot exists.
export const liveOutlineResolvedConfigSchema =
  graphWorkflowResolvedContextSchema
    .pick({
      implementer: true,
      contextValidator: true,
      scriptValidator: true,
      humanApprovalGate: true,
      askUserQuestions: true,
      iterationPolicy: true,
      circuitBreaker: true,
      mutability: true,
      planRepair: true,
      agentValidation: true,
      outputSchema: true,
    })
    .extend({
      contextId: z.string(),
      collaboration: resolvedCollaborationConfigSchema.nullable(),
    })
    .loose();
export type LiveOutlineResolvedConfig = z.infer<
  typeof liveOutlineResolvedConfigSchema
>;

/**
 * The SHAPE of a declared `outputSchema`, never its body (R7.2). The outline
 * sizes prose rather than inlining it, and a declaration is prose: the row says
 * a contract exists and how wide it is, and `--config <ctx>` returns the
 * document itself.
 */
export const liveOutlineOutputSchemaSummarySchema = outputSchemaShapeSchema;
export type LiveOutlineOutputSchemaSummary = z.infer<
  typeof liveOutlineOutputSchemaSummarySchema
>;

/**
 * One edge as the route projection resolved it (D4 R13.2).
 *
 * `source` is the AUTHORED (logical) source — the topology an operator reads —
 * and `effectiveSource` is the instance whose landed work actually satisfies
 * the edge (decision D1). They differ exactly when a concluded loop's external
 * edge resolves onto its concluding pass's exit instance, which is how the
 * outline renders a logical exit with its effective instance as provenance.
 * `null` while the edge is unresolved.
 */
export const liveOutlineRouteSchema = z
  .object({
    id: z.string(),

    source: z.string(),

    effectiveSource: z.union([z.string(), z.null()]).optional(),

    target: z.string(),

    guard: z.enum(["none", "schema", "else"]),

    resolution: z.enum([
      "unresolved",
      "active",
      "inactive",
      "omitted",
      "unevaluable",
    ]),
  })
  .loose();
export type LiveOutlineRoute = z.infer<typeof liveOutlineRouteSchema>;

/** One declared loop's activation, pass counter and budget (R13.2). */
export const liveOutlineLoopSchema = z
  .object({
    loopGroupId: z.string(),

    activation: graphWorkflowLoopStateSchema.shape.activation,

    passCount: z.number(),

    maxPasses: z.number(),

    loopControlRevision: z.number(),
    /** The AUTHORED exit whose external edges the loop holds. */
    logicalExitContextId: z.string(),
    /** The concluding pass's exit instance; null until the loop concludes. */
    concludingExitContextId: z.union([z.string(), z.null()]).optional(),
  })
  .loose();
export type LiveOutlineLoop = z.infer<typeof liveOutlineLoopSchema>;

/** The expansion audit ledgers, flattened for the CLI (R8/R13.2). */
export const liveOutlineExpansionsSchema = z
  .object({
    accepted: z
      .array(
        z
          .object({
            requestId: z.string(),

            invokerContextId: z.string(),

            rationale: z.string(),

            addedContextIds: z.array(z.string()).default([]),

            addedTaskIds: z.array(z.string()).default([]),

            rejoinContextIds: z.array(z.string()).default([]),

            payloadHash: z.string().optional(),

            acceptedAt: z.string(),
          })
          .loose(),
      )
      .default([]),

    refusals: z
      .array(
        z
          .object({
            requestId: z.string(),

            invokerContextId: z.string(),

            refusalCode: z.string(),

            refusedAt: z.string(),
          })
          .loose(),
      )
      .default([]),
  })
  .loose();
export type LiveOutlineExpansions = z.infer<typeof liveOutlineExpansionsSchema>;

export const liveOutlineContextSchema = z
  .object({
    id: z.string(),

    title: z.string(),

    status: graphWorkflowContextStatusSchema,

    editability: liveOutlineEditabilitySchema,
    /** Upstream context ids (edges whose target is this context), in edge order. */
    deps: z.array(z.string()),

    completedTaskCount: z.number(),

    totalTaskCount: z.number(),

    iterationCount: z.number(),

    maxIterations: z.number(),
    /** `null` when the context declares no output contract (free-form). */
    outputSchema: z
      .union([liveOutlineOutputSchemaSummarySchema, z.null()])
      .optional(),
    /**
     * The recorded route verdicts of a `skipped` context (D4 R4); `null` on every
     * other status. The COMPLETE verdict set, exactly as persisted — a skip an
     * operator cannot reconstruct is not an auditable decision.
     */
    skip: z.union([outlineSkipReasonSchema, z.null()]).optional(),
    /** Loop pass membership; `null` for a context outside every loop body. */
    loop: z.union([outlineLoopMembershipSchema, z.null()]).optional(),
    /** The expansion that created this context; `null` when the planner did. */
    provenance: z
      .union([
        z
          .object({
            requestId: z.string(),

            invokerContextId: z.string(),
          })
          .loose(),
        z.null(),
      ])
      .optional(),
  })
  .loose();
export type LiveOutlineContext = z.infer<typeof liveOutlineContextSchema>;

/**
 * One context's output contract and what it has produced (R7.2 CLI read path).
 *
 * `capture` mirrors the states {@link getContextOutput} can report for a
 * context that participates at all; contexts it reports `none` for never appear
 * here, so "absent" unambiguously means "declares nothing and banked nothing".
 * `skipped` is listed rather than dropped — its declared contract is still part
 * of the graph an operator is reading — but never as `pending`, because a
 * not-taken branch owes nothing (D4 R4).
 */
export const liveOutlineContextOutputSchema = z
  .object({
    contextId: z.string(),

    title: z.string().optional(),

    status: graphWorkflowContextStatusSchema.optional(),
    /** `null` when a live edit cleared the declaration after a capture. */
    schema: z
      .union([liveOutlineOutputSchemaSummarySchema, z.null()])
      .optional(),

    capture: z.union([
      z
        .object({
          kind: z.literal("captured"),

          value: z.record(z.string(), z.unknown()),

          capturedAt: z.string(),

          iteration: z.number(),

          parse: outlineCaptureParseSchema,
        })
        .loose(),
      z
        .object({
          kind: z.literal("pending"),
        })
        .loose(),
      z
        .object({
          kind: z.literal("skipped"),
        })
        .loose(),
    ]),
  })
  .loose();
export type LiveOutlineContextOutput = z.infer<
  typeof liveOutlineContextOutputSchema
>;

export const liveOutlineTaskSchema = z
  .object({
    contextId: z.string(),

    order: z.number(),

    id: z.string(),

    status: graphWorkflowTaskStatusSchema,

    title: z.string(),

    instructionChars: z.number(),
  })
  .loose();
export type LiveOutlineTask = z.infer<typeof liveOutlineTaskSchema>;

export const liveOutlineTaskFullSchema = z
  .object({
    contextId: z.string(),

    order: z.number(),

    id: z.string(),

    status: graphWorkflowTaskStatusSchema,

    title: z.string(),

    instructions: z.string(),

    metadata: z.record(z.string(), z.string()).optional(),
  })
  .loose();
export type LiveOutlineTaskFull = z.infer<typeof liveOutlineTaskFullSchema>;

export const liveOutlineContextSectionSchema = z
  .object({
    id: z.string(),

    title: z.string(),

    description: z.union([z.string(), z.null()]),

    acceptanceCriteria: z.string(),

    status: graphWorkflowContextStatusSchema,

    editability: liveOutlineEditabilitySchema,

    deps: z.array(z.string()),

    completedTaskCount: z.number(),

    totalTaskCount: z.number(),

    iterationCount: z.number(),

    maxIterations: z.number(),

    config: liveOutlineResolvedConfigSchema,

    tasks: z.array(liveOutlineTaskFullSchema),
  })
  .loose();
export type LiveOutlineContextSection = z.infer<
  typeof liveOutlineContextSectionSchema
>;

export const liveOutlineSchema = z
  .object({
    header: liveOutlineHeaderSchema,

    contexts: z.array(liveOutlineContextSchema),

    tasks: z.array(liveOutlineTaskSchema),

    config: z.array(liveOutlineContextConfigSchema),
    /**
     * The workflow-scope lane-merge validation selection, straight from the
     * seed-time `workingDefinition` snapshot (workflow tier only — the gate
     * guards the shared fan-in target, so no per-context copy exists). `null`
     * for executions seeded before the snapshot existed.
     */
    laneMergeValidation: z
      .union([graphWorkflowLaneMergeValidationConfigSchema, z.null()])
      .optional(),
    /**
     * Every edge with its guard and resolved verdict (R13.2). Always present and
     * always complete: guard-free routes report `guard: "none"`, so a reader
     * never has to infer "unguarded" from an absent row. The CLI text view
     * renders the block only when there is something conditional to say, which is
     * what keeps a pre-D4 outline's rendering unchanged.
     */
    routes: z.array(liveOutlineRouteSchema).default([]),
    /** Declared loops with their activation, pass counter and budget; `[]` if none. */
    loops: z.array(liveOutlineLoopSchema).default([]),
    /** The expansion audit ledgers; both empty for an execution that never expanded. */
    expansions: liveOutlineExpansionsSchema.default({
      accepted: [],
      refusals: [],
    }),
  })
  .loose();
export type LiveOutline = z.infer<typeof liveOutlineSchema>;

export const liveOutlineSelectorSchema = z.union([
  z
    .object({
      kind: z.literal("outline"),
    })
    .loose(),
  z
    .object({
      kind: z.literal("full"),
    })
    .loose(),
  z
    .object({
      kind: z.literal("context"),

      contextId: z.string(),
    })
    .loose(),
  z
    .object({
      kind: z.literal("task"),

      taskId: z.string(),
    })
    .loose(),
  z
    .object({
      kind: z.literal("config"),

      contextId: z.string(),
    })
    .loose(),
  z
    .object({
      kind: z.literal("charter"),
    })
    .loose(),
  z
    .object({
      kind: z.literal("outputs"),
    })
    .loose(),
]);
export type LiveOutlineSelector = z.infer<typeof liveOutlineSelectorSchema>;

/**
 * The charter selector's payload (doc 07): the full rendered document (content +
 * amendment log — the same markdown the worktree charter.md carries) plus the
 * structured amendment entries and the current content hash.
 */
export const liveOutlineCharterSchema = z
  .object({
    markdown: z.string(),

    amendments: z.array(charterAmendmentSchema),

    charterHash: z.string(),
  })
  .loose();
export type LiveOutlineCharter = z.infer<typeof liveOutlineCharterSchema>;

export const liveOutlineResultSchema = z.union([
  z
    .object({
      ok: z.literal(true),

      section: z.literal("outline"),

      outline: liveOutlineSchema,
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("full"),

      header: liveOutlineHeaderSchema,

      contexts: z.array(liveOutlineContextSectionSchema),
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("context"),

      context: liveOutlineContextSectionSchema,
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("task"),

      task: liveOutlineTaskFullSchema,
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("config"),

      config: liveOutlineResolvedConfigSchema,
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("charter"),

      charter: liveOutlineCharterSchema,
    })
    .loose(),
  z
    .object({
      ok: z.literal(true),

      section: z.literal("outputs"),

      outputs: z.array(liveOutlineContextOutputSchema),
    })
    .loose(),
  z
    .object({
      ok: z.literal(false),

      error: z.string(),
    })
    .loose(),
]);
export type LiveOutlineResult = z.infer<typeof liveOutlineResultSchema>;

// The outputs text reader accepts the section envelope's extra fields.
export const liveOutputsSchema = z
  .object({ outputs: z.array(liveOutlineContextOutputSchema) })
  .loose();
export type LiveOutputsData = z.infer<typeof liveOutputsSchema>;
