import { z } from "zod";
import { charterInvariantSchema, sourceOfTruthSchema } from "./charter-schemas";
import {
  agentAssignmentSchema,
  graphWorkflowAgentValidationOverrideSchema,
  graphWorkflowAskUserQuestionsConfigSchema,
  graphWorkflowCircuitBreakerPolicySchema,
  graphWorkflowHumanApprovalGateConfigSchema,
  graphWorkflowIterationPolicySchema,
  graphWorkflowLaneMergeValidationConfigSchema,
  graphWorkflowLaneMergeValidationOverrideSchema,
  graphWorkflowMutabilityPolicySchema,
  graphWorkflowPlanRepairPolicySchema,
  graphWorkflowScriptValidatorConfigSchema,
  validatorCohortSchema,
} from "@/lib/workflow-graph/config-schemas";
import {
  resolvedCollaborationConfigSchema,
  workflowCollaborationConfigOverrideSchema,
} from "@/lib/workflow-graph/collaboration-schemas";
import {
  contextOutputSchemaSchema,
  contextPlacementSchema,
  graphWorkflowContextRoutingPolicySchema,
  graphWorkflowEdgeGuardSchema,
  graphWorkflowLoopPredicateSchema,
  parameterDeclarationSchema,
  prerequisiteSchema,
  resolvedAgentValidationConfigSchema,
} from "@/lib/workflow-graph/definition-schemas";
// The prose-or-records union (#69 change 4 stage 1). Every edit vocabulary
// replaces the WHOLE value — there are no per-criterion operations at this
// stage, so records arrive already-complete and duplicate ids are refused by
// the union itself at the operation boundary.
import { acceptanceCriteriaSchema } from "@/lib/workflow-graph/criteria/criterion-records";

// ============================================================
// Shared edge-edit shape (D4 R1)
// ============================================================
// Both vocabularies address an edge the same way, so the shapes live here once.
// `remove-edge` keeps its original endpoint form — it is the only addressing an
// existing caller has — and gains `edgeId`, which is the ONLY unambiguous form
// once a definition carries parallel edges between one pair. `update-edge` is
// id-only by construction (D2): there is nothing to update ambiguously.

/** `null` clears the guard (the edge becomes unconditional); absent leaves it. */
const edgeGuardEditShape = {
  when: graphWorkflowEdgeGuardSchema.nullable().optional(),
};

const removeEdgeShape = {
  edgeId: z.string().trim().min(1).optional(),
  sourceContextId: z.string().trim().min(1).optional(),
  targetContextId: z.string().trim().min(1).optional(),
};

const REMOVE_EDGE_ADDRESSING = {
  message:
    "remove-edge requires either edgeId, or both sourceContextId and targetContextId",
} as const;

function hasRemoveEdgeAddressing(value: {
  edgeId?: string | undefined;
  sourceContextId?: string | undefined;
  targetContextId?: string | undefined;
}): boolean {
  if (value.edgeId !== undefined) return true;
  return (
    value.sourceContextId !== undefined && value.targetContextId !== undefined
  );
}

// ============================================================
// Workflow Definition Edits (targeted saved-definition edits)
// ============================================================
// Ordered, atomic domain operations that mutate a SAVED
// `WorkflowDefinitionRecord` (docs/design/cc-cli/05). The verbs and field names
// deliberately mirror the runtime-edit schema below, but the surfaces stay
// separate: runtime edits mutate a running execution's `workingDefinition`,
// these mutate the saved definition. Operations are addressed by stable ids
// (never array indices) so a batch can reference intra-batch additions (add a
// context, then its tasks, then its edges). They are applied sequentially by
// `applyDefinitionEdits` (src/lib/workflow-graph/definition-edits.ts); the final
// mutated definition runs the same accept-time gate as create/replace before
// persisting.

// Relative task placement. Agents never write the numeric `order` field — the
// server renumbers each touched context to a dense 1..n after every task op, so
// the `duplicate-task-order` invariant is unviolable.
const definitionEditTaskPositionSchema = z.union([
  z.object({ at: z.enum(["start", "end"]) }),
  z.object({ after: z.string().trim().min(1) }),
  z.object({ before: z.string().trim().min(1) }),
]);
export type DefinitionEditTaskPosition = z.infer<
  typeof definitionEditTaskPositionSchema
>;

// Per-context config override blocks on `add-context` — additive, so plain
// optional (the same shape a plan.json context carries).
const definitionEditAddContextConfigShape = {
  implementer: agentAssignmentSchema.optional(),
  contextValidator: validatorCohortSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: workflowCollaborationConfigOverrideSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  agentValidation: graphWorkflowAgentValidationOverrideSchema.optional(),
};

// Per-context config override blocks on `update-context` — `null` CLEARS the
// override (restores cascade inheritance); an absent field is untouched.
const definitionEditUpdateContextConfigShape = {
  implementer: agentAssignmentSchema.nullable().optional(),
  contextValidator: validatorCohortSchema.nullable().optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .nullable()
    .optional(),
  mutability: graphWorkflowMutabilityPolicySchema.nullable().optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.nullable().optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.nullable().optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.nullable().optional(),
  collaboration: workflowCollaborationConfigOverrideSchema
    .nullable()
    .optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema
    .nullable()
    .optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema
    .nullable()
    .optional(),
  agentValidation: graphWorkflowAgentValidationOverrideSchema
    .nullable()
    .optional(),
};

// Workflow-level cascade blocks on `update-workflow-config` — `null` CLEARS the
// override. Every tier now carries the same cohort shape, so the workflow and
// context blocks differ only in which tier they land on.
const definitionEditWorkflowConfigShape = {
  implementer: agentAssignmentSchema.nullable().optional(),
  contextValidator: validatorCohortSchema.nullable().optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema
    .nullable()
    .optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.nullable().optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.nullable().optional(),
  mutability: graphWorkflowMutabilityPolicySchema.nullable().optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.nullable().optional(),
  collaboration: workflowCollaborationConfigOverrideSchema
    .nullable()
    .optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema
    .nullable()
    .optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema
    .nullable()
    .optional(),
  agentValidation: graphWorkflowAgentValidationOverrideSchema
    .nullable()
    .optional(),
  // Workflow tier only, mirroring the definition schema: the lane-merge gate
  // guards the shared fan-in target, so it has no per-context counterpart.
  laneMergeValidation: graphWorkflowLaneMergeValidationOverrideSchema
    .nullable()
    .optional(),
};

// Charter content fields shared by the saved-tier `update-charter` op and the
// live `amend-charter` op (docs/design/cc-cli/07) — one shape so the two
// vocabularies cannot drift apart again (the live op grew from a real gap where
// `invariants` was added to the charter schema but never to this op). Partial
// merge: a present scalar sets, an array replaces wholesale, `null` clears an
// optional section, absent leaves untouched. `sourcesOfTruth` is not nullable —
// a charter always keeps at least one ranked source.
const charterContentEditShape = {
  mission: z.string().trim().min(1).optional(),
  conventions: z.array(z.string()).nullable().optional(),
  nonGoals: z.array(z.string()).nullable().optional(),
  vocabulary: z.array(z.string()).nullable().optional(),
  testStrategy: z.string().nullable().optional(),
  knownAmbiguities: z.array(z.string()).nullable().optional(),
  invariants: z.array(charterInvariantSchema).nullable().optional(),
  sourcesOfTruth: z.array(sourceOfTruthSchema).optional(),
};

/** Top-level charter fields an `update-charter`/`amend-charter` op may touch. */
export const CHARTER_CONTENT_EDIT_FIELDS = Object.keys(
  charterContentEditShape,
) as readonly string[];

export const workflowDefinitionEditOperationSchema = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("update-workflow"),
        name: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).nullable().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("update-charter"),
        ...charterContentEditShape,
      })
      .strict()
      .refine(
        (value) =>
          CHARTER_CONTENT_EDIT_FIELDS.some(
            (field) => value[field as keyof typeof value] !== undefined,
          ),
        {
          message:
            "update-charter requires at least one charter field to change (mission, conventions, nonGoals, vocabulary, testStrategy, knownAmbiguities, invariants, sourcesOfTruth) at the top level of the operation",
        },
      ),
    z
      .object({
        type: z.literal("update-workflow-config"),
        ...definitionEditWorkflowConfigShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("add-context"),
        id: z.string().trim().min(1),
        title: z.string().trim().min(1),
        acceptanceCriteria: acceptanceCriteriaSchema,
        description: z.string().trim().min(1).optional(),
        // Context identity, not a config override — so it sits beside `title`
        // rather than in the cascade block above, and carries no `null` clear
        // (an absent field on a brand-new context IS the cleared state).
        outputSchema: contextOutputSchemaSchema.optional(),
        routing: graphWorkflowContextRoutingPolicySchema.optional(),
        // Same identity tier. Optional in the VOCABULARY, required in the
        // definition: the applier gives a placement-less add the single-member
        // lane an added context already had, so an existing caller keeps working
        // and a caller that means to group says so explicitly.
        placement: contextPlacementSchema.optional(),
        ...definitionEditAddContextConfigShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("update-context"),
        contextId: z.string().trim().min(1),
        title: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).nullable().optional(),
        acceptanceCriteria: acceptanceCriteriaSchema.optional(),
        // Present replaces the declaration wholesale (a JSON Schema document has
        // no meaningful partial merge), `null` drops it and returns the context
        // to free-form output, absent leaves it untouched.
        outputSchema: contextOutputSchemaSchema.nullable().optional(),
        // Same replace/clear semantics; `null` returns the context to the
        // `independent` default.
        routing: graphWorkflowContextRoutingPolicySchema.nullable().optional(),
        // Replaces wholesale, and NOT nullable: a context always has a placement,
        // so there is no cleared state to spell. Moving lanes and re-drawing owned
        // paths are one edit because the grade discriminates on both.
        placement: contextPlacementSchema.optional(),
        ...definitionEditUpdateContextConfigShape,
      })
      .strict(),
    z
      .object({
        type: z.literal("remove-context"),
        contextId: z.string().trim().min(1),
        deleteTasks: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("add-task"),
        id: z.string().trim().min(1),
        contextId: z.string().trim().min(1),
        title: z.string().trim().min(1),
        instructions: z.string().trim().min(1),
        metadata: z.record(z.string(), z.string()).optional(),
        position: definitionEditTaskPositionSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("update-task"),
        taskId: z.string().trim().min(1),
        title: z.string().trim().min(1).optional(),
        instructions: z.string().trim().min(1).optional(),
        metadata: z.record(z.string(), z.string()).nullable().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("remove-task"),
        taskId: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("move-task"),
        taskId: z.string().trim().min(1),
        contextId: z.string().trim().min(1).optional(),
        position: definitionEditTaskPositionSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("reorder-tasks"),
        contextId: z.string().trim().min(1),
        orderedTaskIds: z.array(z.string().trim().min(1)).min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("add-edge"),
        sourceContextId: z.string().trim().min(1),
        targetContextId: z.string().trim().min(1),
        when: graphWorkflowEdgeGuardSchema.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("update-edge"),
        edgeId: z.string().trim().min(1),
        ...edgeGuardEditShape,
      })
      .strict()
      .refine((value) => value.when !== undefined, {
        message: "update-edge requires at least one field to change",
      }),
    z
      .object({
        type: z.literal("remove-edge"),
        ...removeEdgeShape,
      })
      .strict()
      .refine(hasRemoveEdgeAddressing, REMOVE_EDGE_ADDRESSING),
    z
      .object({
        type: z.literal("add-parameter"),
        declaration: parameterDeclarationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("update-parameter"),
        name: z.string().trim().min(1),
        declaration: parameterDeclarationSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("remove-parameter"),
        name: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("add-prerequisite"),
        prerequisite: prerequisiteSchema,
      })
      .strict(),
    // Matched by identity (kind + path/skill); prerequisites carry no ids.
    z
      .object({
        type: z.literal("remove-prerequisite"),
        kind: z.enum(["path", "skill"]),
        path: z.string().trim().min(1).optional(),
        skill: z.string().trim().min(1).optional(),
      })
      .strict(),
  ],
);
export type DefinitionEditOperation = z.infer<
  typeof workflowDefinitionEditOperationSchema
>;

export const workflowDefinitionEditRequestSchema = z.object({
  // Optimistic-concurrency guard: the revision the edits were authored against.
  // The server rejects with `stale_workflow_definition` if the stored revision
  // differs.
  expectedRevision: z.number().int().min(1),
  // Full apply + validate, report the outcome, persist nothing.
  dryRun: z.boolean().optional(),
  operations: z.array(workflowDefinitionEditOperationSchema).min(1),
});
export type WorkflowDefinitionEditRequest = z.infer<
  typeof workflowDefinitionEditRequestSchema
>;

// ============================================================
// Workflow Live Edits (live editing of a launched execution)
// ============================================================
// Ordered, atomic domain operations that mutate a RUNNING execution's resolved
// `workingDefinition` + runtime maps (docs/design/cc-cli/06). These live
// ALONGSIDE the doc-05 saved-definition edit union and the legacy task-only
// runtime-edit schema — the route swap is a downstream slice, so all three
// coexist until then. Names mirror doc 05 where semantics match; addressing is
// always by stable id.
//
// Unlike the doc-05 blocks (which edit AUTHORED overrides where `null` clears an
// override to restore cascade inheritance), live edits set CONCRETE RESOLVED
// values — there is no cascade at runtime (doc 06, D1). Every block is plain
// optional (present = set the value); turning validation off is a cohort with
// `enabled: false`, which keeps the dormant assignments a null could not.
const liveEditContextConfigShape = {
  implementer: agentAssignmentSchema.optional(),
  contextValidator: validatorCohortSchema.optional(),
  scriptValidator: graphWorkflowScriptValidatorConfigSchema.optional(),
  humanApprovalGate: graphWorkflowHumanApprovalGateConfigSchema.optional(),
  askUserQuestions: graphWorkflowAskUserQuestionsConfigSchema.optional(),
  iterationPolicy: graphWorkflowIterationPolicySchema.optional(),
  circuitBreaker: graphWorkflowCircuitBreakerPolicySchema.optional(),
  mutability: graphWorkflowMutabilityPolicySchema.optional(),
  planRepair: graphWorkflowPlanRepairPolicySchema.optional(),
  collaboration: resolvedCollaborationConfigSchema.optional(),
  // Live edits write the RESOLVED per-role allowlists (with provenance), same
  // contract as `collaboration`. Selector command names are validated against
  // the project registry at the edit boundary; a live edit affects future
  // submissions only — in-flight validation runs keep their snapshot.
  agentValidation: resolvedAgentValidationConfigSchema.optional(),
};

/**
 * The content a started loop's versioned body template still admits (R11.2,
 * R12): context prose, acceptance criteria, and task ops addressed at TEMPLATE
 * tasks. Deliberately a restricted sub-union rather than the full live-edit
 * vocabulary — membership (which contexts form the body, which is entry, which
 * is exit, and the internal edges between them) has no representation here, so
 * a membership edit is refused by the schema rather than by a check a future op
 * could forget. Config blocks are likewise absent: a template edit changes what
 * the body is asked to do, never the controls it runs under.
 *
 * Ids address the TEMPLATE (`worker`, `task-worker`), never a minted pass
 * instance — an edit aimed at a materialized pass is an ordinary context edit
 * and answers to the ordinary freeze rules.
 */
const loopTemplateContentOperationSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("update-context"),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).nullable().optional(),
      acceptanceCriteria: acceptanceCriteriaSchema.optional(),
    })
    .refine(
      (value) =>
        value.title !== undefined ||
        value.description !== undefined ||
        value.acceptanceCriteria !== undefined,
      { message: "update-context requires at least one field to change" },
    ),
  z.object({
    type: z.literal("add-task"),
    id: z.string().trim().min(1).optional(),
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    position: definitionEditTaskPositionSchema.optional(),
  }),
  z
    .object({
      type: z.literal("update-task"),
      taskId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      instructions: z.string().trim().min(1).optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    })
    .refine(
      (value) =>
        value.title !== undefined ||
        value.instructions !== undefined ||
        value.metadata !== undefined,
      {
        message:
          "update-task requires at least one of title, instructions, or metadata",
      },
    ),
  z.object({
    type: z.literal("remove-task"),
    taskId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("reorder-tasks"),
    contextId: z.string().trim().min(1),
    orderedTaskIds: z.array(z.string().trim().min(1)).min(1),
  }),
]);
export type LoopTemplateContentOperation = z.infer<
  typeof loopTemplateContentOperationSchema
>;

export const workflowLiveEditOperationSchema = z.discriminatedUnion("type", [
  // Versioned charter amendment (docs/design/cc-cli/07): partial-merges the
  // shared charter content shape onto the execution's charter, propagates to
  // every non-frozen context copy, and appends a rationale-bearing entry to the
  // execution's amendment log. Quiescence-gated like structural ops.
  z
    .object({
      type: z.literal("amend-charter"),
      // The "why" — recorded verbatim in the amendment log and rendered into
      // prompts/charter.md so future agents see that the rules changed and why.
      rationale: z.string().trim().min(1),
      ...charterContentEditShape,
    })
    .refine(
      (value) =>
        Object.entries(value).some(
          ([key, fieldValue]) =>
            key !== "type" && key !== "rationale" && fieldValue !== undefined,
        ),
      {
        message: "amend-charter requires at least one charter field to change",
      },
    ),
  z
    .object({
      type: z.literal("update-context"),
      contextId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).nullable().optional(),
      acceptanceCriteria: acceptanceCriteriaSchema.optional(),
      // Same replace/clear semantics as the saved tier: an output schema is an
      // authored identity field mirrored onto the resolved context, so it is
      // one of the few fields whose live vocabulary matches doc 05 exactly.
      outputSchema: contextOutputSchemaSchema.nullable().optional(),
      // Likewise an identity field, not a cascade result (D4 R3).
      routing: graphWorkflowContextRoutingPolicySchema.nullable().optional(),
      // Identity again, and the live tier's spelling matches doc 05 exactly:
      // present replaces the whole placement, absent leaves it. The editability
      // tiers decide WHEN it may change (unstarted freely, started only at
      // quiescence); the frontier decides whether the new envelope can coexist
      // with the lane siblings that are already running (lwp R10.2).
      placement: contextPlacementSchema.optional(),
      ...liveEditContextConfigShape,
    })
    .refine(
      (value) =>
        Object.entries(value).some(
          ([key, fieldValue]) =>
            key !== "type" && key !== "contextId" && fieldValue !== undefined,
        ),
      { message: "update-context requires at least one field to change" },
    ),
  z.object({
    type: z.literal("add-context"),
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    acceptanceCriteria: acceptanceCriteriaSchema,
    description: z.string().trim().min(1).optional(),
    outputSchema: contextOutputSchemaSchema.optional(),
    routing: graphWorkflowContextRoutingPolicySchema.optional(),
    // Same identity tier as the saved `add-context`: optional in the vocabulary
    // so a placement-less add keeps its single-member lane, present when the
    // caller means to join an existing one.
    placement: contextPlacementSchema.optional(),
    // Seed the new context's resolved config from this context's resolved config
    // when present, else from resolved global defaults; explicit blocks override.
    // NOT a source for `outputSchema` or `placement`: copying one context's
    // output contract or lane ownership onto another is never what an author
    // means (D1 — per-context identity).
    configFromContextId: z.string().trim().min(1).optional(),
    ...liveEditContextConfigShape,
  }),
  z.object({
    type: z.literal("remove-context"),
    contextId: z.string().trim().min(1),
    deleteTasks: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("add-task"),
    // Optional slug — minted server-side when absent (doc 06). Present ids let a
    // batch reference the addition (e.g. add a task, then move it).
    id: z.string().trim().min(1).optional(),
    contextId: z.string().trim().min(1),
    title: z.string().trim().min(1),
    instructions: z.string().trim().min(1),
    metadata: z.record(z.string(), z.string()).optional(),
    position: definitionEditTaskPositionSchema.optional(),
  }),
  z
    .object({
      type: z.literal("update-task"),
      taskId: z.string().trim().min(1),
      title: z.string().trim().min(1).optional(),
      instructions: z.string().trim().min(1).optional(),
      metadata: z.record(z.string(), z.string()).nullable().optional(),
    })
    .refine(
      (value) =>
        value.title !== undefined ||
        value.instructions !== undefined ||
        value.metadata !== undefined,
      {
        message:
          "update-task requires at least one of title, instructions, or metadata",
      },
    ),
  z.object({
    type: z.literal("remove-task"),
    taskId: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("move-task"),
    taskId: z.string().trim().min(1),
    targetContextId: z.string().trim().min(1),
    position: definitionEditTaskPositionSchema.optional(),
  }),
  z.object({
    type: z.literal("reorder-tasks"),
    contextId: z.string().trim().min(1),
    orderedTaskIds: z.array(z.string().trim().min(1)).min(1),
  }),
  z.object({
    type: z.literal("add-edge"),
    // Generic live edits may derive the id from the endpoints. An audited
    // amendment supplies its own id so the durable record names the same edge
    // the caller requested (`cctl workflow live amend`).
    id: z.string().trim().min(1).optional(),
    sourceContextId: z.string().trim().min(1),
    targetContextId: z.string().trim().min(1),
    when: graphWorkflowEdgeGuardSchema.optional(),
  }),
  z
    .object({
      type: z.literal("update-edge"),
      edgeId: z.string().trim().min(1),
      ...edgeGuardEditShape,
    })
    .refine((value) => value.when !== undefined, {
      message: "update-edge requires at least one field to change",
    }),
  z
    .object({
      type: z.literal("remove-edge"),
      ...removeEdgeShape,
    })
    .refine(hasRemoveEdgeAddressing, REMOVE_EDGE_ADDRESSING),
  // Unroll one pass of a declared loop group (D4 R9). ENGINE-ONLY: it is
  // refused unless the caller carries the server-derived loop-settlement
  // authority, which only the scheduler's settlement transaction sets — no
  // client-facing entry point can. It lives in this union rather than in a
  // parallel one so there stays exactly one op vocabulary, one dispatch, and
  // one place the locked-region and contract gates run.
  //
  // Deliberately deep: the op derives the whole batch (context, task and edge
  // clones plus the prior-exit wiring edge) from the group's versioned body
  // template, so the reserved id scheme and the clone fidelity D10 requires
  // cannot drift across callers.
  z.object({
    type: z.literal("materialize-loop-pass"),
    loopGroupId: z.string().trim().min(1),
    /** The pass to materialize; 2+ — the seed resolver materializes pass 1. */
    pass: z.number().int().min(2),
  }),
  // The three edits R11.2 admits on a STARTED loop. Everything else about a
  // running loop is frozen, and the freeze is enforced by the vocabulary rather
  // than by a runtime check wherever it can be: there is no operation that names
  // a body's membership, its entry or exit, its internal edges, or the
  // per-execution pass backstop, so those edits are unrepresentable.
  z.object({
    type: z.literal("raise-loop-max-passes"),
    loopGroupId: z.string().trim().min(1),
    /**
     * The new cap. Raising is the only direction admitted (the core refuses a
     * value that does not exceed the current one), and the accept-time ceiling
     * refuses anything above the unraisable execution backstop.
     */
    maxPasses: z.number().int().min(2),
    /** Optional here — only a predicate amendment demands a rationale (R11). */
    rationale: z.string().trim().min(1).optional(),
  }),
  z.object({
    type: z.literal("amend-loop-predicate"),
    loopGroupId: z.string().trim().min(1),
    until: graphWorkflowLoopPredicateSchema,
    /**
     * REQUIRED by the schema, so an amendment with no "why" is refused before
     * any gate runs (R12.2). Recorded verbatim in the loop-control amendment
     * log; the amendment is never retroactive, so the log is the only place the
     * reason a completed pass's bar moved survives.
     */
    rationale: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("edit-loop-template"),
    loopGroupId: z.string().trim().min(1),
    operations: z.array(loopTemplateContentOperationSchema).min(1),
  }),
  // Workflow-scope, like `amend-charter`: rewrites the execution's resolved
  // lane-merge validation snapshot (a CONCRETE value — no cascade at runtime).
  // Command names are registry-preflighted at the edit boundary; the edit
  // affects future merge submissions only — an in-flight merge keeps the
  // selection it was submitted with (validation-concurrency §6).
  z.object({
    type: z.literal("update-lane-merge-validation"),
    laneMergeValidation: graphWorkflowLaneMergeValidationConfigSchema,
  }),
]);
export type WorkflowLiveEditOperation = z.infer<
  typeof workflowLiveEditOperationSchema
>;

export const workflowLiveEditRequestSchema = z.object({
  // Must match the active execution's id (route rejects a mismatch, D7).
  executionId: z.string().min(1),
  // Optimistic-concurrency guard: the `liveRevision` the edits were authored
  // against; the route rejects with `revision_conflict` if it differs (D4).
  baseLiveRevision: z.number().int().min(1),
  // Trusted client self-identification for audit/SSE attribution (D15).
  // `lane-agent` is server-derived on the lane route only — never accepted here.
  source: z.enum(["cli", "ui"]),
  // Advisory validation without a write (route runs gates against a snapshot).
  dryRun: z.boolean().optional(),
  operations: z.array(workflowLiveEditOperationSchema).min(1),
});
export type WorkflowLiveEditRequest = z.infer<
  typeof workflowLiveEditRequestSchema
>;
