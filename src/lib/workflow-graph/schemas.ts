import { z } from "zod";
import {
  conflictDecisionInputSchema,
  conflictEntrySchema,
  deliveryGateHaltReasonSchema,
} from "@/lib/jobs/schemas";
import { agentFailureClassificationSchema } from "@/lib/agent-backends/errors";
import {
  askQuestionAnswerSchema,
  askQuestionItemSchema,
} from "@/lib/conversations/schemas";
import { sessionDiffSchema } from "@/lib/git/schemas";
import {
  agentBackendIdShapeSchema,
  agentBackendSchema,
  agentSessionRefSchema,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import {
  laneMetricsSchema,
  laneTurnUsageSchema,
} from "@/lib/workflows/primitives/lane-vocabulary";
import { agentCallStructuredOutputParseSchema } from "@/lib/workflows/primitives/agent-call-vocabulary";
import {
  charterAmendmentSchema,
  workflowCharterSchema,
} from "@/lib/workflows/charter-schemas";
import { EXPANSION_CAPS } from "./expansion-caps";
import { graphWorkflowCircuitBreakerConditionSchema } from "./config-schemas";
import {
  graphWorkflowCollaborationContinuationSchema,
  graphWorkflowPendingCollaborationSchema,
} from "./collaboration-schemas";
import {
  contextOutputSchemaSchema,
  graphWorkflowContextStatusSchema,
  graphWorkflowSharedDocumentEntrySchema,
  graphWorkflowStatusSchema,
  graphWorkflowTaskStatusSchema,
  graphWorkflowVisualLayoutSchema,
  resolvedWorkflowSemanticDefinitionSchema,
  workflowAdvisoryIdentitySchema,
  workflowSemanticDefinitionSchema,
  workflowValidatorAdvisorySchema,
  workflowValidatorIssueSchema,
} from "./definition-schemas";
import { agentProfileRefSchema } from "@/lib/agent-profiles/schemas";

// ============================================================
// Graph Workflow Halt Reasons
// ============================================================

export const graphWorkflowHaltReasonSchema = z.discriminatedUnion("type", [
  deliveryGateHaltReasonSchema,
  z.object({
    type: z.literal("circuit_breaker"),
    contextId: z.string().trim().min(1),
    condition: graphWorkflowCircuitBreakerConditionSchema,
    failureCount: z.number().int().min(0).optional(),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("max_iterations"),
    contextId: z.string().trim().min(1),
    iterationCount: z.number().int().min(0),
    // Populated by the plan-repair supervisor (docs/design/cc-cli/08) when a
    // repair round declines, fails, or exhausts its attempts — mirrors the
    // `circuit_breaker` variant so the halt UI explains itself for both
    // retry-exhaustion kinds. Additive; pre-D1 rows parse as null.
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("recovery_error"),
    message: z.string().trim().min(1),
  }),
  z.object({
    type: z.literal("aborted"),
    // Why the abort happened, when something other than a user's abort button
    // caused it. `migration_cutover` is the hard-cutover migration ending a
    // non-terminal run's resume path; `definition_rejected` is a human ending a
    // parked launch at the definition gate (D7 decision D17), carried on the
    // record itself so a History row is recognizably reviewed-and-rejected
    // without reading the event ledger beside it. `summary` explains either in
    // the inspector, mirroring the `max_iterations.summary` precedent. Additive
    // — a user-initiated abort (and every pre-cutover row) parses as null, and
    // resumability is unchanged: an abort is terminal whatever caused it.
    cause: z
      .enum(["migration_cutover", "definition_rejected"])
      .nullable()
      .default(null),
    summary: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal("validator_infra_error"),
    contextId: z.string().trim().min(1),
    engine: agentBackendSchema,
    infraReason: z.enum([
      "exception",
      "unparseable",
      "schema_mismatch",
      // The global query semaphore never admitted the specialist. Distinct
      // because nothing about the validator failed — the engine was saturated —
      // and an operator reading the halt needs to know to look at load rather
      // than at the reviewer.
      "never_admitted",
    ]),
    message: z.string(),
    summary: z.string().nullable().default(null),
    // Which specialist ran out of attempts, how many it spent, and the round it
    // spent them in. Additive: a pre-cohort halt row parses with all three null
    // or zero, and resumability is unchanged.
    assignmentId: z.string().nullable().default(null),
    attempts: z.number().int().min(0).default(0),
    roundSeq: z.number().int().positive().nullable().default(null),
  }),
  z.object({
    type: z.literal("script_validator_missing_command"),
    contextId: z.string().trim().min(1),
    message: z.string(),
  }),
  // The engine could not read the tree a validation round would freeze on, and
  // retrying did not help. Terminal rather than a retry-forever incident: a
  // round that cannot prove what it reviewed cannot be deterministic, and
  // returning the context to ready would spin against the same broken git.
  z.object({
    type: z.literal("validation_candidate_unavailable"),
    contextId: z.string().trim().min(1),
    attempts: z.number().int().positive(),
    message: z.string(),
  }),
  z.object({
    type: z.literal("script_validator_unknown_command"),
    contextId: z.string().trim().min(1),
    commandName: z.string().trim().min(1),
    message: z.string(),
  }),
  z.object({
    type: z.literal("merge_failure"),
    contextId: z.string().trim().min(1),
    message: z.string(),
    conflictFiles: z.array(z.string()).default([]),
  }),
  z.object({
    type: z.literal("join_failure"),
    joinId: z.string().trim().min(1),
    joinKind: z.enum(["context_merge", "final_publish"]),
    contextId: z.string().trim().min(1).nullable().default(null),
    sourceLaneIds: z.array(z.string().trim().min(1)).min(1),
    targetLaneId: z.string().trim().min(1),
    message: z.string(),
    conflictFiles: z.array(z.string()).default([]),
    // Set when the conflict resolver failed before reaching a verdict (backend
    // quota, transport, abort, timeout). `conflictFiles` above is then the
    // merge's context rather than the cause, and `retryable` decides whether
    // anything but a human restoring capacity can change the outcome. Optional
    // rather than defaulted: a join that failed on content carries no
    // classification, and neither does a halt recorded before this field.
    resolutionFailure: agentFailureClassificationSchema.optional(),
  }),
  z.object({
    type: z.literal("merge_precondition_failed"),
    contextId: z.string().trim().min(1),
    targetBranch: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
    message: z.string(),
  }),
  z.object({
    type: z.literal("agent_turn_failed"),
    contextId: z.string().trim().min(1),
    engine: agentBackendSchema,
    cause: z.enum(["sdk_error", "abort", "timeout", "stall", "unknown"]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("worktree_creation_dirty"),
    contextId: z.string().trim().min(1).nullable().default(null),
    worktreePath: z.string().trim().min(1),
    branchName: z.string().trim().min(1),
    dirtyPaths: z
      .array(
        z.object({
          path: z.string(),
          statusCode: z.string(),
          tracked: z.boolean(),
        }),
      )
      .max(5)
      .default([]),
    totalDirtyCount: z.number().int().min(0),
  }),
  z.object({
    type: z.literal("execution_loop_failed"),
    contextId: z.string().trim().min(1).nullable().default(null),
    message: z.string(),
    cause: z.enum(["sdk_error", "validation", "io", "unknown"]),
  }),
  /**
   * A source's outgoing conditional branches under- or over-selected against
   * its declared `routing.cardinality` (D4 R3.1). Resumable: the sanctioned
   * remedy is a quiescent live edit of the guard set (or of the policy), then
   * resume — the completed source is never re-run and never edited.
   */
  z.object({
    type: z.literal("routing_cardinality"),
    contextId: z.string().trim().min(1),
    policy: z.enum(["atLeastOne", "exactlyOne"]),
    outcome: z.enum(["under-selection", "over-selection"]),
    conditionalEdgeIds: z.array(z.string().trim().min(1)).default([]),
    activatedEdgeIds: z.array(z.string().trim().min(1)).default([]),
    message: z.string(),
  }),
  /**
   * A completed conditional source whose captured output cannot be read
   * (pending, none, or orphaned), so its guards cannot be evaluated (D4 R2.4).
   * Resumable, and deliberately NOT evaluated as false: the remedy is a
   * quiescent live edit of the unstarted target's incoming edges — amend or
   * remove the guard — followed by resume.
   */
  z.object({
    type: z.literal("routing_invariant"),
    contextId: z.string().trim().min(1),
    reason: z.literal("guard-unevaluable"),
    edgeIds: z.array(z.string().trim().min(1)).default([]),
    sourceContextIds: z.array(z.string().trim().min(1)).default([]),
    message: z.string(),
  }),
  /**
   * An ACTIVE loop whose exit instance resolved `skipped` (D4 R9.6). The exit
   * produces the verdict a pass settles on, so a skipped exit leaves the loop
   * with nothing to decide. Refused at accept time by the reconvergence rule,
   * so reaching this means a live edit opened the branch; resumable, and the
   * remedy is a quiescent edit of the pass instance's incoming edges.
   */
  z.object({
    type: z.literal("loop_exit_skipped"),
    loopGroupId: z.string().trim().min(1),
    pass: z.number().int().min(1),
    contextId: z.string().trim().min(1),
    message: z.string(),
  }),
  /**
   * An active loop whose exit landed but whose captured output cannot be read
   * (D4 R9.6). Deliberately not treated as an unsatisfied verdict: unrolling
   * another pass on an unreadable exit is exactly the guess R9 forbids.
   */
  z.object({
    type: z.literal("loop_invariant"),
    loopGroupId: z.string().trim().min(1),
    pass: z.number().int().min(1),
    contextId: z.string().trim().min(1),
    reason: z.literal("exit-output-unevaluable"),
    message: z.string(),
  }),
  /**
   * A loop that asked for another pass and was refused (D4 R10, locked Q15 —
   * there is no completion-on-exhaustion mode). Raised only AFTER the predicate
   * was evaluated, so a satisfying verdict on the last allowed pass concludes
   * normally (R9.3).
   *
   * Two budgets raise it and `scope` says which: `loop` for the group's own
   * mandatory `maxPasses`, `execution` for the per-execution total-pass backstop
   * that bounds every loop together. The distinction is what an operator acts
   * on — a `loop` halt can be repaired by an audited cap amendment, while the
   * backstop is a constant neither operators nor plan repair can raise.
   */
  z.object({
    type: z.literal("loop_limit_reached"),
    scope: z.enum(["loop", "execution"]).default("loop"),
    loopGroupId: z.string().trim().min(1),
    /**
     * The pass whose decision was refused another one — the exhausted pass. A
     * backstop halt raised before a loop ever activated carries `1`, the pass it
     * could not have, alongside a null verdict and a zero `passCount`.
     */
    pass: z.number().int().min(1),
    maxPasses: z.number().int().min(1),
    /**
     * The exit verdict that asked for another pass; null only when the backstop
     * refused an ACTIVATION, which has no verdict behind it.
     */
    verdict: z.enum(["satisfied", "unsatisfied"]).nullable().default(null),
    /** Passes of THIS loop that exist at the halt. */
    passCount: z.number().int().min(0).default(0),
    /** Live pass slots across EVERY loop, weighed against the backstop. */
    totalPassCount: z.number().int().min(0).default(0),
    contextId: z.string().trim().min(1),
    message: z.string(),
    /**
     * The plan-repair supervisor's verdict on this halt, once it has spoken
     * (R12). Same role as the context halts' `summary`: the halt UI explains
     * why an automated repair declined, failed, or gave up. Deliberately NOT
     * part of the halt-dedup identity — a repair verdict is bookkeeping about
     * the halt, never a different halt.
     */
    summary: z.string().nullable().default(null),
  }),
  /**
   * A landing found worktree changes that no current lane member's declared
   * ownership, scratch, or payload directory accounts for (lightweight
   * parallelism R8). Raised per LANE, not per context: git cannot attribute a
   * shared worktree's changes to an agent, so `contextId` is the member whose
   * landing noticed — the reporter, never an accusation.
   *
   * Resumable and repairable by construction: the sanctioned remedy is to widen
   * a member's ownership through the live-edit path (or to remove the write)
   * and resume, which is exactly what plan repair is able to do unattended.
   */
  z.object({
    type: z.literal("ownership_violation"),
    laneId: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
    unattributedPaths: z.array(z.string().min(1)).max(50).default([]),
    message: z.string(),
  }),
  z.object({
    type: z.literal("collaboration_failure"),
    status: z.enum([
      "converged",
      "rounds_exhausted",
      "requires_user_input",
      "objective_disagreement",
    ]),
    brief: z.string().trim().min(1),
    executionContextId: z.string().trim().min(1),
    conversationId: z.string().trim().min(1),
    summary: z.string().trim().min(1),
  }),
]);
export type GraphWorkflowHaltReason = z.infer<
  typeof graphWorkflowHaltReasonSchema
>;

// ============================================================
// Graph Workflow Lanes
// ============================================================

const graphWorkflowExecutionLaneIdSchema = z.string().trim().min(1);

const graphWorkflowExecutionLaneKindSchema = z.enum(["session", "worktree"]);

const graphWorkflowExecutionLaneStatusSchema = z.enum([
  "pending",
  "active",
  "merged",
  "halted",
]);

// Append-only audit/recovery record of commits on a lane. Git remains the
// authoritative source for the lane's current HEAD; these snapshots exist to
// reconstruct lane history and to support recovery after crashes.
const graphWorkflowExecutionLaneCommitSnapshotSchema = z.object({
  contextId: z.string().trim().min(1),
  sha: z.string().trim().min(1),
  committedAt: z.string(),
});
export type GraphWorkflowExecutionLaneCommitSnapshot = z.infer<
  typeof graphWorkflowExecutionLaneCommitSnapshotSchema
>;

/**
 * One entry of a lane's provisioning-time ignored baseline: an ignored path as
 * the ignore rules name it, plus a digest of the files it actually contained.
 *
 * The digest is what makes the baseline usable. Git names a wholly-ignored
 * directory by the directory alone however many files are inside it, so a
 * baseline of names could only ever answer "was `node_modules` here?" — never
 * "is what is under it still what provisioning installed?". Recording the names
 * of all those files instead would put a repo-sized list in the execution's
 * persisted state; a digest over them costs one line and answers the same
 * question, at the price of naming the directory rather than the new file when
 * they differ.
 */
export const graphWorkflowIgnoredBaselineEntrySchema = z.object({
  /** Repo-relative, no trailing slash even for a directory. */
  path: z.string().min(1),
  /** Over the sorted paths and byte/filesystem fingerprints beneath it. */
  digest: z.string().min(1),
});
export type GraphWorkflowIgnoredBaselineEntry = z.infer<
  typeof graphWorkflowIgnoredBaselineEntrySchema
>;

export const graphWorkflowExecutionLaneStateSchema = z.object({
  laneId: graphWorkflowExecutionLaneIdSchema,
  kind: graphWorkflowExecutionLaneKindSchema,
  status: graphWorkflowExecutionLaneStatusSchema,
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().trim().min(1),
  includedContextIds: z.array(z.string().trim().min(1)).default([]),
  lastCommittingContextId: z.string().trim().min(1).nullable().default(null),
  commitSnapshots: z
    .array(graphWorkflowExecutionLaneCommitSnapshotSchema)
    .default([]),
  /**
   * The ignored content this lane's worktree already held when it was
   * provisioned (R8, decision D8). Drift classification gives `.gitignore` no
   * blanket exemption, so it needs to know which ignored content predates the
   * members — everything else ignored and unowned is a write nobody declared.
   *
   * Empty on the session lane and on every lane recorded before the field
   * existed, which reads as "no ignored path is pre-existing". That is the
   * fail-closed direction: it can only surface a halt an operator dismisses,
   * never hide a write.
   */
  ignoredBaseline: z.array(graphWorkflowIgnoredBaselineEntrySchema).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type GraphWorkflowExecutionLaneState = z.infer<
  typeof graphWorkflowExecutionLaneStateSchema
>;

// ============================================================
// Graph Workflow Joins
// ============================================================

const graphWorkflowExecutionJoinIdSchema = z.string().trim().min(1);
export const graphWorkflowExecutionJoinKindSchema = z.enum([
  "context_merge",
  "final_publish",
]);
export type GraphWorkflowExecutionJoinKind = z.infer<
  typeof graphWorkflowExecutionJoinKindSchema
>;

export const graphWorkflowExecutionJoinStatusSchema = z.enum([
  "pending",
  "running",
  "succeeded",
  "failed",
  "conflicts",
]);
export type GraphWorkflowExecutionJoinStatus = z.infer<
  typeof graphWorkflowExecutionJoinStatusSchema
>;

export const graphWorkflowExecutionJoinConflictDetailSchema = z.object({
  files: z.array(z.string().trim().min(1)).default([]),
  message: z.string().nullable().default(null),
  // Per-file conflict analysis from the merge machine's resolver, persisted so
  // a join_failure halt can show the operator what conflicted and why the
  // automatic resolution failed, not just a file list.
  analysis: z.array(conflictEntrySchema).nullable().default(null),
});
export type GraphWorkflowExecutionJoinConflictDetail = z.infer<
  typeof graphWorkflowExecutionJoinConflictDetailSchema
>;
// A conflict the merge machinery resolved WITHOUT failing the join: either a
// smart-merge LLM sub-turn merged the conflicted files, or the runner's one
// clean retry merged cleanly after a failed resolution attempt. Recorded so a
// "succeeded" join is distinguishable from a conflict-free one — audit
// tooling must not report clean merges when any of these exist.
export const graphWorkflowExecutionJoinResolvedConflictSchema = z.object({
  sourceLaneId: graphWorkflowExecutionLaneIdSchema,
  files: z.array(z.string().trim().min(1)).default([]),
  resolution: z.enum(["sub_turn", "clean_retry"]),
  analysis: z.array(conflictEntrySchema).nullable().default(null),
});
export type GraphWorkflowExecutionJoinResolvedConflict = z.infer<
  typeof graphWorkflowExecutionJoinResolvedConflictSchema
>;
export const graphWorkflowExecutionJoinValidationEvidenceSchema = z.object({
  sourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema).min(1),
  contextIds: z.array(z.string().trim().min(1)),
  /**
   * The `+`-joined validation command list this barrier actually ran, `""`
   * when the configured selection was empty (debt still clears — there is
   * nothing to run — so the ledger has to say so rather than imply a run).
   * Optional because evidence recorded before the ledger tracked identity says
   * nothing about which commands ran, which is not the same claim as `""`.
   */
  commandIdentity: z.string().optional(),
  recordedAt: z.string(),
});
export type GraphWorkflowExecutionJoinValidationEvidence = z.infer<
  typeof graphWorkflowExecutionJoinValidationEvidenceSchema
>;
export const graphWorkflowExecutionJoinStateSchema = z.object({
  joinId: graphWorkflowExecutionJoinIdSchema,
  kind: graphWorkflowExecutionJoinKindSchema,
  // context_merge joins are anchored to the joining context. final_publish joins
  // orchestrate the workflow-wide publish and are not tied to a single context.
  contextId: z.string().trim().min(1).nullable().default(null),
  targetLaneId: graphWorkflowExecutionLaneIdSchema,
  sourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema).min(1),
  // Per-source progress for resume-safety. Each merged source lane is appended
  // here after the merge runner reports success (including no-op merges). The
  // runner skips lanes already present here on resume.
  mergedSourceLaneIds: z.array(graphWorkflowExecutionLaneIdSchema).default([]),
  // Deferred lanes remain validation debt until a validating merge succeeds;
  // this survives halt/resume independently of merge progress.
  validationDebtSourceLaneIds: z
    .array(graphWorkflowExecutionLaneIdSchema)
    .default([]),
  // Membership snapshot taken when the join intent is planned. The lane's
  // mutable includedContextIds remains useful operational state, but barrier
  // coverage expands through this frozen map so a replay proves which members
  // the original intent covered. The planner always populates this map;
  // recovery treats its absence as unknown coverage and uses lane state.
  sourceLaneContextIds: z
    .record(
      graphWorkflowExecutionLaneIdSchema,
      z.array(z.string().trim().min(1)),
    )
    .optional(),
  // Append-only successful barrier records. Evidence is absent until the first
  // validating merge completes.
  validationEvidence: z
    .array(graphWorkflowExecutionJoinValidationEvidenceSchema)
    .optional(),
  status: graphWorkflowExecutionJoinStatusSchema,
  errorMessage: z.string().nullable().default(null),
  conflicts: graphWorkflowExecutionJoinConflictDetailSchema
    .nullable()
    .default(null),
  // Optional (not defaulted) so pre-existing states and fixtures stay valid
  // without churn; absent means "no auto-resolved conflicts recorded".
  resolvedConflicts: z
    .array(graphWorkflowExecutionJoinResolvedConflictSchema)
    .optional(),
  // Operator guidance attached when a failed join is reset for retry; consumed
  // as per-file decisions by the next conflict-resolution attempt and cleared
  // when the join concludes.
  conflictGuidance: z
    .array(conflictDecisionInputSchema)
    .nullable()
    .default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().default(null),
});
export type GraphWorkflowExecutionJoinState = z.infer<
  typeof graphWorkflowExecutionJoinStateSchema
>;

// ============================================================
// Graph Workflow Approvals + User Input
// ============================================================

export const graphWorkflowApprovalDecisionSchema = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("approved"), decidedAt: z.string() }),
    z.object({
      type: z.literal("rejected"),
      message: z.string().trim().min(1),
      decidedAt: z.string(),
    }),
  ],
);
export type GraphWorkflowApprovalDecision = z.infer<
  typeof graphWorkflowApprovalDecisionSchema
>;

/**
 * How one parked context's approval view is scoped — decided WHEN THE GATE
 * OPENS and frozen with the pending record (R15, decision D9).
 *
 * Frozen rather than re-derived, because a context's placement stays
 * live-editable while its gate stands: pausing an execution and re-placing a
 * parked context must not re-scope the bytes a human is already deciding on.
 * Reading the live placement at render time would do exactly that.
 *
 * One union rather than a nullable snapshot for the same reason. A full-access
 * member and an enveloped member whose candidate could not be read are
 * different answers, and a null cannot tell them apart — disambiguating them
 * after the fact by consulting the live placement reintroduces the drift this
 * field exists to prevent. Making the three states explicit means the surface
 * never has to guess.
 *
 * For `scoped`, this is a reference and not the bytes: `treeHash` is the
 * owned-subset identity computed from the same temporary index the patch is
 * read from, so the approval surface can re-read the patch and PROVE it is the
 * frozen one instead of persisting a copy of it in the execution blob.
 * `headSha` is recorded for the operator and deliberately NOT compared — a
 * concurrent same-lane sibling landing moves HEAD without touching anything
 * this context owns, and treating that as drift would blank the approval view
 * every time a sibling lands. An EMPTY `ownedPaths` is the read-only grade,
 * whose change set is empty by construction, not a degenerate whole-tree one.
 */
export const graphWorkflowApprovalScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whole_tree") }).strict(),
  z
    .object({
      kind: z.literal("scoped"),
      ownedPaths: z.array(z.string().trim().min(1)),
      treeHash: z.string().trim().min(1),
      headSha: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("unreadable"),
      reason: z.string().trim().min(1),
    })
    .strict(),
]);
export type GraphWorkflowApprovalScope = z.infer<
  typeof graphWorkflowApprovalScopeSchema
>;

export const graphWorkflowPendingApprovalSchema = z.object({
  conversationId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
  decision: graphWorkflowApprovalDecisionSchema.nullable().default(null),
  /**
   * Defaulted rather than optional: every record written before this field
   * existed belongs to a full-access member (authored placement arrives with
   * this same change), so an absent field has exactly one correct reading.
   */
  approvalScope: graphWorkflowApprovalScopeSchema.default({
    kind: "whole_tree",
  }),
});
export type GraphWorkflowPendingApproval = z.infer<
  typeof graphWorkflowPendingApprovalSchema
>;

/**
 * The change set the human approval surface renders for an ENVELOPED context:
 * exactly the paths that context owns, at the identity its gate froze (R15.2).
 *
 * `treeHash` travels with the patch for the same reason it travels with a
 * validation round's: it is the identity the bytes were read under, so a reader
 * can say what the diff is a diff OF. It is only ever the frozen one — a read
 * that disagrees is reported as drift instead, never rendered.
 */
export const graphWorkflowApprovalSnapshotSchema = z
  .object({
    contextId: z.string().trim().min(1),
    ownedPaths: z.array(z.string().trim().min(1)),
    treeHash: z.string().trim().min(1),
    diff: sessionDiffSchema,
  })
  .strict();
export type GraphWorkflowApprovalSnapshot = z.infer<
  typeof graphWorkflowApprovalSnapshotSchema
>;

/**
 * What the approval API answers with for one parked context.
 *
 * The union is the point. `whole_tree` is not an absent snapshot but a positive
 * statement that this member reviews the whole worktree — what a full-access
 * member has always reviewed, and what the session's own diff view shows.
 * `drifted` is fail-closed and deliberately carries no patch: the gate's claim
 * is that the human decides on the candidate it froze, and a re-read that no
 * longer matches that identity is not that candidate.
 *
 * Lives here rather than beside the server-side resolver because the client
 * parses it, and the resolver reaches git.
 */
export const graphWorkflowApprovalSnapshotResponseSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("scoped"),
      snapshot: graphWorkflowApprovalSnapshotSchema,
    }),
    z.object({ kind: z.literal("whole_tree"), contextId: z.string() }),
    z.object({
      kind: z.literal("drifted"),
      contextId: z.string(),
      frozenTreeHash: z.string(),
      observedTreeHash: z.string(),
    }),
    z.object({ kind: z.literal("unavailable"), reason: z.string() }),
  ],
);
export type GraphWorkflowApprovalSnapshotResponse = z.infer<
  typeof graphWorkflowApprovalSnapshotResponseSchema
>;

export const graphWorkflowDefinitionApprovalSchema = z.object({
  requestedAt: z.string().trim().min(1),
  approvedAt: z.string().trim().min(1).nullable().default(null),
});
export type GraphWorkflowDefinitionApproval = z.infer<
  typeof graphWorkflowDefinitionApprovalSchema
>;

/**
 * An approval decision this server has reserved but not yet made (D7 R14.2).
 *
 * Approving a park is a saga across two authorities — this graph's serialized
 * row and the registered admission consumer's own durable records — and either
 * order of those two writes is unsound on its own: approving first leaves a
 * gate-refused act with an irreversibly approved run, admitting first leaves a
 * losing act's admission behind. So the act reserves first, and the reservation
 * is deliberately NOT the approval: the run stays `pending` with
 * `definitionApproval.approvedAt` still null, and only an admitted holder
 * finalizes. Kept beside the approval record rather than inside it so no reader
 * can mistake a decision in flight for a decision made.
 *
 * Held only for the duration of one act. A crash strands it, which restart
 * normalization releases — the park would otherwise be undecidable, since
 * approve and reject both refuse while a decision is in flight.
 *
 * `claimId` is what makes the reservation an identity rather than a flag. A
 * sweep that reclaims a stranded reservation does not stop the act that made
 * it — that act may simply have been slow — so its remaining moves have to fail
 * against the holder that replaced it. Without the id, a superseded act would
 * release the new holder's reservation out from under a live admission, or
 * finalize a decision the new holder is still making.
 */
export const graphWorkflowDefinitionApprovalClaimSchema = z.object({
  claimId: z.string().trim().min(1),
  claimedAt: z.string().trim().min(1),
});
export type GraphWorkflowDefinitionApprovalClaim = z.infer<
  typeof graphWorkflowDefinitionApprovalClaimSchema
>;

// Answers recorded for a parked user-input question batch. The answer
// primitives are reused from the conversation domain (never duplicated).
export const graphWorkflowUserInputAnswersSchema = z.object({
  byQuestionId: z.record(z.string(), askQuestionAnswerSchema),
  answeredAt: z.string().trim().min(1),
});
export type GraphWorkflowUserInputAnswers = z.infer<
  typeof graphWorkflowUserInputAnswersSchema
>;

// The parked-question record of ONE lane on a context awaiting user input.
// `questions` is a snapshot copied from the lane conversation at park time so
// the graph UI and the resume prompt are self-sufficient; `answers` is null
// until the operator answers (or is set pre-park for a fast answer).
//
// `roundSeq` completes the record's token: an answer is routable only if it
// names both the batch it answers and the validation round that batch was asked
// in. A batch id alone cannot tell a live question from one a superseded round
// left behind, and a round that has been concluded (pause-to-edit) must refuse
// the answer its parked validator is still holding a form for.
export const graphWorkflowPendingUserInputSchema = z.object({
  conversationId: z.string().trim().min(1),
  lane: z.enum(["implementer", "context_validator"]),
  questionBatchId: z.string().trim().min(1),
  questions: z.array(askQuestionItemSchema),
  requestedAt: z.string().trim().min(1),
  /** The validation round this park belongs to; null for an implementer park. */
  roundSeq: z.number().int().positive().nullable().default(null),
  answers: graphWorkflowUserInputAnswersSchema.nullable().default(null),
});
export type GraphWorkflowPendingUserInput = z.infer<
  typeof graphWorkflowPendingUserInputSchema
>;

// ============================================================
// Graph Workflow Validation Rounds
// ============================================================

/**
 * Which lane a session belongs to. Defined here rather than beside the agent
 * session refs below because a validator's provenance — persisted on the round
 * record and republished on its events — needs it.
 */
export const graphWorkflowLaneKindSchema = z.enum([
  "implementer",
  "context_validator",
]);
export type GraphWorkflowLaneKind = z.infer<typeof graphWorkflowLaneKindSchema>;

function normalizeLegacyValidationSessionRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) {
    if (record.lane !== undefined && record.refKind !== undefined) return value;
    return {
      ...record,
      lane: record.lane ?? "context_validator",
      refKind: record.refKind ?? "backend",
    };
  }

  if (record.engine === "claude") {
    return {
      backend: record.engine,
      ref: record.conversationId,
      lane: record.lane,
      refKind: "conversation",
      workflowConversationId: record.conversationId,
    };
  }
  if (record.engine === "codex") {
    return {
      backend: record.engine,
      ref: record.threadId,
      lane: record.lane,
      refKind: "backend",
    };
  }
  return value;
}

/**
 * Where a validator's review actually happened.
 *
 * Persisted on the round record AND carried on the events the round publishes:
 * a verdict a resume carries forward has to keep pointing at the session that
 * rendered it, or a cohort's retained lanes become unauditable the moment the
 * process running them restarts.
 */
export const graphWorkflowValidationSessionRefSchema = z.preprocess(
  normalizeLegacyValidationSessionRef,
  z.object({
    backend: agentBackendIdShapeSchema,
    ref: z.string().trim().min(1),
    lane: graphWorkflowLaneKindSchema,
    // Which cohort member rendered this verdict. Additive and optional: rows
    // written before cohorts existed name a lane but no assignment, and the
    // implementer lane never renders one.
    assignmentId: z.string().trim().min(1).optional(),
    refKind: z.enum(["conversation", "backend"]),
    workflowConversationId: z.string().trim().min(1).optional(),
  }),
);
export type GraphWorkflowValidationSessionRef = z.infer<
  typeof graphWorkflowValidationSessionRefSchema
>;

const graphWorkflowValidationReviewUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  /** Estimated from token usage because providers do not report USD. */
  costUsd: z.number().nullable().default(null),
});

/**
 * Usage for conversation-strategy validators, derived from the conversation
 * transcript after the turn. Token counts are not projected from transcripts,
 * so this carries the billable figures the transcript does report — without
 * it every conversation-validator decision is unpriced in cost audits.
 */
const graphWorkflowValidationConversationUsageSchema = z.object({
  costUsd: z.number().nullable().default(null),
  apiTurns: z.number().int().min(0).nullable().default(null),
});
export type GraphWorkflowValidationConversationUsage = z.infer<
  typeof graphWorkflowValidationConversationUsageSchema
>;

function normalizeLegacyValidationReviewArtifact(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;

  if (record.engine === "claude") {
    return {
      backend: record.engine,
      kind: "conversation",
      ref: record.conversationId,
    };
  }
  if (record.engine === "codex") {
    return {
      backend: record.engine,
      kind: "response",
      ref: record.threadId,
      response: record.response,
      usage: record.usage,
    };
  }
  return value;
}

/** What a validator produced, and what it cost to produce. */
export const graphWorkflowValidationReviewArtifactSchema = z.preprocess(
  normalizeLegacyValidationReviewArtifact,
  z.discriminatedUnion("kind", [
    z.object({
      backend: agentBackendIdShapeSchema,
      kind: z.literal("conversation"),
      ref: z.string().trim().min(1),
      usage: graphWorkflowValidationConversationUsageSchema
        .nullable()
        .default(null),
    }),
    z.object({
      backend: agentBackendIdShapeSchema,
      kind: z.literal("response"),
      ref: z.string().trim(),
      response: z.string(),
      usage: graphWorkflowValidationReviewUsageSchema.nullable().default(null),
    }),
  ]),
);
export type GraphWorkflowValidationReviewArtifact = z.infer<
  typeof graphWorkflowValidationReviewArtifactSchema
>;

export function buildGraphWorkflowValidationReviewArtifact(input: {
  backend: AgentBackendId;
  strategy: "conversation" | "task";
  ref: string | null;
  response: string;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    costUsd: number | null;
  } | null;
  /** Transcript-derived usage for conversation-strategy validators. */
  conversationUsage?: GraphWorkflowValidationConversationUsage | null;
}): GraphWorkflowValidationReviewArtifact | null {
  if (input.ref === null) return null;
  if (input.strategy === "conversation") {
    return {
      backend: input.backend,
      kind: "conversation",
      ref: input.ref,
      usage: input.conversationUsage ?? null,
    };
  }
  return {
    backend: input.backend,
    kind: "response",
    ref: input.ref,
    response: input.response,
    usage: input.usage,
  };
}

/**
 * The exact thing a validation round reviews.
 *
 * `candidateTreeHash` is read from the SAME temporary index the diff pipeline
 * builds (`computeCandidateTreeHash`), so untracked content and file modes are
 * inside the identity while gitignored build artifacts and lane logs are outside
 * it — coextensive with what the validators actually see. `headSha` pins the base
 * commit and `taskStateHash` covers the context's task tuples, so a task
 * completed or reopened mid-round moves the identity too.
 *
 * `identityScope` says which reading of "the candidate" the other components
 * carry, and it is what makes the identity usable by a context confined to part
 * of a shared lane worktree (R15):
 *  - `wholeTree` — `candidateTreeHash` is the git tree object written from the
 *    whole index, and `headSha` is load-bearing: the base commit moving means the
 *    candidate moved;
 *  - `owned` — `candidateTreeHash` is a digest over exactly the context's owned
 *    subset, and `headSha` is recorded for the operator but NOT compared. A
 *    concurrent same-lane sibling landing its own work moves HEAD without
 *    touching anything this context owns, and charging that as drift would make
 *    an enveloped context's round un-completable whenever a sibling lands.
 *
 * The two identity forms are never comparable, which is why the scope is part of
 * the identity rather than context a reader has to supply. It defaults to
 * `wholeTree` so every round frozen before ownership existed reads back as the
 * whole-tree candidate it actually was.
 *
 * Every component is required. A round exists to make "every specialist judged
 * THIS candidate" checkable, and an identity with a missing component cannot
 * support that claim — so an unresolvable candidate is an infrastructure outcome
 * that prevents the round from opening, never a candidate with holes in it that
 * later compares equal to itself.
 */
export const graphWorkflowValidationCandidateSchema = z
  .object({
    headSha: z.string().trim().min(1),
    candidateTreeHash: z.string().trim().min(1),
    taskStateHash: z.string().trim().min(1),
    identityScope: z.enum(["wholeTree", "owned"]).default("wholeTree"),
  })
  .strict();
export type GraphWorkflowValidationCandidate = z.infer<
  typeof graphWorkflowValidationCandidateSchema
>;

/**
 * One frozen cohort seat. It records what the assignment WAS when the round
 * opened, so a live config edit mid-round is visible as a divergence rather
 * than silently redefining who reviewed the candidate.
 */
export const graphWorkflowValidationRosterEntrySchema = z
  .object({
    assignmentId: z.string().trim().min(1),
    profileRef: agentProfileRefSchema,
    revision: z.number().int().positive(),
    resolvedInstructionHash: z.string().trim().min(1),
    strategy: z.enum(["conversation", "task"]),
  })
  .strict();
export type GraphWorkflowValidationRosterEntry = z.infer<
  typeof graphWorkflowValidationRosterEntrySchema
>;

export const graphWorkflowValidationSpecialistStateSchema = z.enum([
  "pending",
  "running",
  "verdict_pass",
  "verdict_fail",
  "infra_failed",
  "parked",
]);
export type GraphWorkflowValidationSpecialistState = z.infer<
  typeof graphWorkflowValidationSpecialistStateSchema
>;

/**
 * Why an admitted dispatch failed as infrastructure rather than as a review.
 * `never_admitted` is absent by construction: the queue refusing a lane costs
 * no attempt, so it can never be the failure that spent one.
 */
export const graphWorkflowValidationInfraReasonSchema = z.enum([
  "exception",
  "unparseable",
  "schema_mismatch",
]);

/**
 * One advisory as the round RECORD holds it: what was observed, the identity the
 * engine stamped on it, and everything that has since happened to it.
 *
 * Delivery and disposition live on the advisory itself rather than in a parallel
 * ledger because they are facts ABOUT this advisory, and a ledger keyed by
 * identity would be a second place for them to disagree. `deliveredAt` is what
 * makes delivery exactly-once: the engine delivers the advisories of this round
 * that carry none, and stamps them in the same mutation that delivers them.
 */
export const graphWorkflowValidationAdvisorySchema =
  workflowValidatorAdvisorySchema.extend({
    identity: workflowAdvisoryIdentitySchema,
    /** When the implementer was shown it. Null until it has been delivered. */
    deliveredAt: z.string().nullable().default(null),
    /**
     * What the implementer did with it. Null before the response turn, and null
     * forever for an advisory delivered on a failing round — that round's
     * remediation turn answers with work, not with a disposition record.
     *
     * Only ever the response turn's gate-validated answer (R7/D7). Nothing else
     * may write here: an outcome the engine chose because the turn produced none
     * would be a decision no one made, recorded as one somebody did. So a batch
     * delivered by the response turn is stamped delivered and disposed in one
     * mutation, and a turn that cannot produce a valid set fails instead.
     */
    disposition: z
      .object({
        outcome: z.enum(["addressed", "declined", "deferred"]),
        reason: z.string().nullable().default(null),
        recordedAt: z.string(),
      })
      .strict()
      .nullable()
      .default(null),
  });
export type GraphWorkflowValidationAdvisory = z.infer<
  typeof graphWorkflowValidationAdvisorySchema
>;

export const graphWorkflowValidationSpecialistSchema = z
  .object({
    state: graphWorkflowValidationSpecialistStateSchema,
    attempts: z.number().int().min(0).default(0),
    summary: z.string().nullable().default(null),
    issues: z.array(workflowValidatorIssueSchema).default([]),
    /**
     * This lane's non-blocking observations, in the order it reported them.
     * Written when the lane's verdict is accepted, so a round resumed after a
     * crash carries forward the advisories of every lane that already settled
     * rather than delivering only what the final pass happened to re-run.
     */
    advisories: z.array(graphWorkflowValidationAdvisorySchema).default([]),
    /**
     * The parked question batch this specialist is waiting on. Per-lane, so
     * several specialists in one context can be parked at once.
     */
    questionToken: z.string().nullable().default(null),
    /**
     * Where this lane's verdict was rendered and what it cost.
     *
     * Persisted rather than held in memory because a round outlives the process
     * that ran it: a resume rebuilds its retained verdicts from this record, and
     * a reconstruction without these would publish an aggregate whose retained
     * specialists point at no session, no artifact, and no spend (D12).
     */
    sessionRef: graphWorkflowValidationSessionRefSchema
      .nullable()
      .default(null),
    reviewArtifact: graphWorkflowValidationReviewArtifactSchema
      .nullable()
      .default(null),
    /**
     * The infrastructure failure that spent this lane's most recent attempt.
     *
     * Stored with the count it explains: `attempts` alone says a budget was
     * consumed but not by what, so a lane recovered at its bound after a crash
     * could only halt with a reason the restart invented. Null for a lane that
     * has not failed on infrastructure in this round.
     */
    lastInfraFailure: z
      .object({
        reason: graphWorkflowValidationInfraReasonSchema,
        message: z.string(),
        engine: agentBackendSchema,
      })
      .nullable()
      .default(null),
  })
  .strict();
export type GraphWorkflowValidationSpecialist = z.infer<
  typeof graphWorkflowValidationSpecialistSchema
>;

/**
 * The context's latest validation round: what is being reviewed, by whom, and
 * how far the round has got. The cohort owns the candidate — and the implementer
 * is locked out — exactly while `phase` is not `concluded`.
 *
 * A concluded round is RETAINED rather than cleared. `seq` is what tells two
 * rounds of one context apart when they happen to freeze byte-identical
 * candidates, so it has to survive the round it numbers: clearing the record on
 * conclusion would restart numbering at 1 every time and make a result from an
 * earlier round indistinguishable from a current one.
 */
export const graphWorkflowValidationRoundSchema = z
  .object({
    seq: z.number().int().positive(),
    candidate: graphWorkflowValidationCandidateSchema,
    roster: z.array(graphWorkflowValidationRosterEntrySchema),
    specialists: z.record(z.string(), graphWorkflowValidationSpecialistSchema),
    phase: z.enum(["script", "specialists", "concluded"]),
    /** How the round ended; null while it is still open. */
    outcome: z
      .enum([
        "script_failed",
        "candidate_mismatch",
        "roster_drift",
        "passed",
        "failed",
      ])
      .nullable()
      .default(null),
    startedAt: z.string().trim().min(1),
  })
  .strict();
export type GraphWorkflowValidationRound = z.infer<
  typeof graphWorkflowValidationRoundSchema
>;

/**
 * The context's advisory-response phase: what a passing round with fresh
 * advisories owes before the context may finish (R8, D8).
 *
 * A phase of the CONTEXT rather than of the round, because the round is over by
 * the time it starts. The round concluded on its verdict, the cohort released
 * the candidate, and it is the implementer that is about to run — the exact
 * opposite of what an open round means. Two states, and the field's absence is
 * the third:
 *
 * - `awaiting_response`: the round certified the candidate and its advisories
 *   owe the implementer one turn. Nothing opens a new round while this stands,
 *   so a restart mid-turn resumes the turn instead of re-reviewing a candidate
 *   that was already certified.
 * - `recertifying`: the response turn moved the candidate out from under that
 *   certification. The next round is a blocking-only re-certification, and this
 *   record is what makes that survive a restart — a phase held only in memory
 *   would come back as an ordinary round with the advisory lanes in it.
 *
 * `roundSeq` names the certification the phase belongs to; the candidate itself
 * is read from that round rather than copied here, so there is one recorded
 * answer to "what was certified" and not two that can disagree.
 */
export const graphWorkflowAdvisoryResponsePhaseSchema = z
  .object({
    roundSeq: z.number().int().positive(),
    phase: z.enum(["awaiting_response", "recertifying"]),
    enteredAt: z.string().trim().min(1),
  })
  .strict();
export type GraphWorkflowAdvisoryResponsePhase = z.infer<
  typeof graphWorkflowAdvisoryResponsePhaseSchema
>;

/**
 * One long-lived advisory as the execution-level index projects it (D9).
 *
 * Only `plan` and `out_of_scope` are indexed: an `implementation` advisory is
 * about the work of the round that raised it and is answered there, while these
 * two outlive it — their audience is the human reading the run today and the
 * owning agent of roadmap D8 tomorrow, neither of whom should have to open
 * every round of every context to find them.
 *
 * A projection, not a second copy: the advisory itself — description, delivery,
 * disposition — stays on the round record, and this carries only what a reader
 * needs to recognise one and go to it. The origin round is `identity.roundSeq`
 * and the origin seat is `identity.assignmentId`; repeating either beside the
 * identity would be a second place for them to disagree. `contextId` is here
 * because identity alone does not carry it — round numbering is per context.
 */
export const graphWorkflowAdvisoryIndexEntrySchema = z
  .object({
    identity: workflowAdvisoryIdentitySchema,
    kind: z.enum(["plan", "out_of_scope"]),
    title: z.string().trim().min(1),
    contextId: z.string().trim().min(1),
  })
  .strict();
export type GraphWorkflowAdvisoryIndexEntry = z.infer<
  typeof graphWorkflowAdvisoryIndexEntrySchema
>;

// ============================================================
// Graph Workflow Context + Task State
// ============================================================

/**
 * One incoming edge's contribution to a skip decision (D4 R4.3). Mirrors
 * `RouteEdgeEvaluation` in the route projection, which is where the verdicts
 * are computed; the projection stays structural and browser-safe, so the
 * persisted spelling lives here and `context-transitions.test.ts` pins the two
 * shapes together.
 */
export const graphWorkflowRouteEdgeEvaluationSchema = z.object({
  edgeId: z.string().trim().min(1),
  verdict: z.enum(["active", "inactive", "omitted"]),
});
export type GraphWorkflowRouteEdgeEvaluation = z.infer<
  typeof graphWorkflowRouteEdgeEvaluationSchema
>;

/**
 * Why a context was skipped: the COMPLETE verdict set of its incoming edges at
 * the moment the skip was decided, not just the edges that vetoed it. A fan-in
 * waits for every route before deciding, so the partial set would not explain
 * the decision — and this record is what makes the routing reconstructible
 * from durable state alone.
 */
export const graphWorkflowContextSkipReasonSchema = z.object({
  edgeEvaluations: z.array(graphWorkflowRouteEdgeEvaluationSchema),
  at: z.string().trim().min(1),
});
export type GraphWorkflowContextSkipReason = z.infer<
  typeof graphWorkflowContextSkipReasonSchema
>;

/**
 * How a context's work reaches the lane its dependents read — recorded when the
 * context is DISPATCHED, not when it finishes (D4 decision D8), so no landing
 * evidence ever exists only in memory.
 *
 * Each mode leaves its own replayable evidence. `lane_commit` and `solo_commit`
 * embed {@link token} in the commit message, so reconciliation can probe the
 * branch for the token; a self-authored commit adopted at head-advance is
 * evidenced instead by the recorded `baselineSha` → `headSha` range.
 * `fan_in_merge` reconciles against the join record named by `joinId`.
 *
 * Route settlement treats only `landed` as satisfied: a `pending` or `failed`
 * intent BLOCKS the dependents (it never skips them, R2.5), because a merge
 * that has not resolved is not evidence that a branch was not taken.
 */
export const graphWorkflowLandingIntentSchema = z.object({
  mode: z.enum(["lane_commit", "solo_commit", "fan_in_merge"]),
  /**
   * Monotonic per context. A reset-and-redispatch mints a fresh token so a
   * commit from the previous attempt is never adopted as this attempt's
   * evidence.
   */
  attempt: z.number().int().min(1),
  token: z.string().trim().min(1),
  laneId: z.string().trim().min(1).nullable().default(null),
  worktreePath: z.string().nullable().default(null),
  /** Lane head at assignment; the low end of the adopted-commit SHA range. */
  baselineSha: z.string().nullable().default(null),
  /** The landed head — the high end of that range. Null until settled. */
  headSha: z.string().nullable().default(null),
  /** The fan-in join this intent reconciles against, for `fan_in_merge`. */
  joinId: z.string().trim().min(1).nullable().default(null),
  state: z.enum(["pending", "landed", "failed"]),
  /** How the landing was established, for replay/forensics. */
  evidence: z
    .enum(["commit", "adopted-head", "no-changes", "join-merge"])
    .nullable()
    .default(null),
  recordedAt: z.string(),
  settledAt: z.string().nullable().default(null),
});
export type GraphWorkflowLandingIntent = z.infer<
  typeof graphWorkflowLandingIntentSchema
>;

/**
 * A placement's write surface as the scheduler FROZE it: symlink-resolved
 * absolute paths under the lane worktree, decided once at admission.
 *
 * Persisted because it is load-bearing twice over. Admission compares a
 * candidate against it, so a concurrent scheduler and a later pass judge
 * collisions against the same bytes; and dispatch composes the turn's write
 * envelope from it rather than re-resolving, so a symlink retargeted between
 * admission and dispatch cannot widen what the turn may write.
 *
 * `canonicalPrefixes` is empty for both non-owning grades, which mean opposite
 * things — `full` writes everywhere, `readOnly` writes nowhere — so the grade
 * travels with the set instead of being inferred from it.
 */
export const graphWorkflowCanonicalOwnershipSchema = z.object({
  mode: z.enum(["full", "owned", "readOnly"]),
  canonicalPrefixes: z.array(z.string().min(1)).default([]),
});
export type GraphWorkflowCanonicalOwnership = z.infer<
  typeof graphWorkflowCanonicalOwnershipSchema
>;

/**
 * A lane claimed by a scheduling batch that has not finalized yet.
 *
 * Context-level reservation stamps alone cannot carry this: a stamped context
 * has no `laneId` until finalize, so a concurrent scheduler cannot tell which
 * lane it is about to occupy, nor that the lane's worktree is already being
 * provisioned by someone else. Keying the claim by LANE answers both — later
 * members of the same batch coalesce behind it, and a different batch waits
 * rather than racing `git worktree add` for the same path (decision D5).
 */
export const graphWorkflowLaneReservationSchema = z.object({
  laneId: z.string().trim().min(1),
  /** The batch that owns this reservation; only it may finalize or release it. */
  batchId: z.string().trim().min(1),
  /** Whether the owning batch is provisioning this lane's worktree and branch. */
  provisioning: z.boolean().default(false),
  members: z
    .array(
      z.object({
        contextId: z.string().trim().min(1),
        ownership: graphWorkflowCanonicalOwnershipSchema,
      }),
    )
    .default([]),
  createdAt: z.string(),
});
export type GraphWorkflowLaneReservation = z.infer<
  typeof graphWorkflowLaneReservationSchema
>;

export const graphWorkflowExecutionContextStateSchema = z.object({
  contextId: z.string().trim().min(1),
  status: graphWorkflowContextStatusSchema,
  totalTaskCount: z.number().int().min(0),
  completedTaskCount: z.number().int().min(0).default(0),
  iterationCount: z.number().int().min(0).default(0),
  consecutiveFailureCount: z.number().int().min(0).default(0),
  worktreePath: z.string().nullable().default(null),
  branchName: z.string().nullable().default(null),
  isolation: z.enum(["session", "worktree"]).default("session"),
  batchId: z.string().nullable().default(null),
  /**
   * Owner-discriminated scheduling reservation (Design 3.1). A scheduler's short
   * sync RESERVE mutation stamps the batch id it is provisioning under here,
   * BEFORE it provisions worktrees out of the lock; `getEligibleContextIds`
   * treats a stamped context as ineligible, so a concurrent same-epoch scheduler
   * cannot re-classify and double-provision it. The owning pass clears it at its
   * fenced finalize (or on compensation); a superseding loop epoch clears any
   * leftover. Optional/absent means unreserved.
   */
  reservedByBatchId: z.string().nullable().optional(),
  /**
   * The write envelope this context was ADMITTED under, frozen at reservation
   * and consumed unchanged by dispatch (decision D4). Null on a context that
   * has never been admitted, and on every row written before the field existed.
   */
  reservedOwnership: graphWorkflowCanonicalOwnershipSchema
    .nullable()
    .optional(),
  laneId: graphWorkflowExecutionLaneIdSchema.nullable().default(null),
  joinId: graphWorkflowExecutionJoinIdSchema.nullable().default(null),
  mergeStatus: z
    .enum([
      "not-applicable",
      "pending",
      "in-progress",
      "merged-success",
      "merged-failed",
      "conflicts",
    ])
    .default("not-applicable"),
  cleanupStatus: z
    .enum(["not-applicable", "pending", "removed", "failed"])
    .default("not-applicable"),
  lastMergeError: z.string().nullable().default(null),
  pendingApproval: graphWorkflowPendingApprovalSchema.nullable().default(null),
  /**
   * Parked questions, keyed by lane key (`implementer` or
   * `context_validator:<assignmentId>` — see `lane-identity`).
   *
   * A record rather than a single slot because a cohort's validators ask
   * independently: several may be waiting on the human at once, and an answer
   * belongs to the lane that asked it. An absent key is a lane that is not
   * parked; the empty record is a context with nothing pending.
   */
  pendingUserInputs: z
    .record(z.string(), graphWorkflowPendingUserInputSchema)
    .default({}),
  /**
   * The latest validation round, open or concluded, or absent/null when this
   * context has never had one. Optional rather than defaulted, matching
   * `reservedByBatchId`: absent, null, and "no round yet" are the same claim,
   * and rows written before the field existed already make it correctly.
   */
  validationRound: graphWorkflowValidationRoundSchema.nullable().optional(),
  /** Set only on a `skipped` context; null everywhere else (D4 R4). */
  skipReason: graphWorkflowContextSkipReasonSchema.nullable().default(null),
  /**
   * How this context's work is going to land, recorded at DISPATCH (D4
   * decision D8). Null on a context that has never been dispatched, and on
   * every pre-D4 row.
   */
  landingIntent: graphWorkflowLandingIntentSchema.nullable().default(null),
  /**
   * The advisory-response phase this context is in, or absent/null when it is in
   * none. Optional for the same reason as `validationRound`: absent and null are
   * one claim, and every row written before the field existed already makes it.
   */
  advisoryResponse: graphWorkflowAdvisoryResponsePhaseSchema
    .nullable()
    .optional(),
});
export type GraphWorkflowExecutionContextState = z.infer<
  typeof graphWorkflowExecutionContextStateSchema
>;

const graphWorkflowTaskValidationFailureSchema = z.object({
  message: z.string(),
  timestamp: z.string(),
});
export type GraphWorkflowTaskValidationFailure = z.infer<
  typeof graphWorkflowTaskValidationFailureSchema
>;
const graphWorkflowTaskStateSchema = z.object({
  taskId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  order: z.number().int().min(1),
  status: graphWorkflowTaskStatusSchema,
  summary: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  lastConversationId: z.string().nullable().default(null),
  failureMessage: z.string().nullable().default(null),
  failureHistory: z.array(graphWorkflowTaskValidationFailureSchema).default([]),
});
export type GraphWorkflowTaskState = z.infer<
  typeof graphWorkflowTaskStateSchema
>;

// ============================================================
// Graph Workflow Session Refs + Agent Session State
// ============================================================

function normalizeLegacyGraphSessionRef(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;
  if (record.engine === "claude") {
    return { backend: record.engine, ref: record.conversationId };
  }
  if (record.engine === "codex") {
    return { backend: record.engine, ref: record.threadId };
  }
  return value;
}

export const graphWorkflowExecutionSessionRefSchema = z.preprocess(
  normalizeLegacyGraphSessionRef,
  agentSessionRefSchema,
);
export type GraphWorkflowExecutionSessionRef = z.infer<
  typeof graphWorkflowExecutionSessionRefSchema
>;

export type GraphWorkflowAgentSessionTurnUsage = z.infer<
  typeof laneTurnUsageSchema
>;

function optionalMetric(
  record: Record<string, unknown>,
  legacyKey: string,
): Record<string, unknown> {
  const value = record[legacyKey];
  return value === null || value === undefined ? {} : { value };
}

function normalizeLegacyGraphLane(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record.backend !== undefined) return value;
  if (record.engine !== "claude" && record.engine !== "codex") return value;

  const contextTokens = optionalMetric(record, "lastContextTokens").value;
  const contextWindowMax = optionalMetric(record, "lastContextWindowMax").value;
  const lastTurnUsage = optionalMetric(record, "lastTurnUsage").value;
  const normalizedSessionRef =
    record.sessionRef !== undefined
      ? normalizeLegacyGraphSessionRef(record.sessionRef)
      : undefined;
  const legacyConversationId =
    record.engine === "claude" &&
    typeof normalizedSessionRef === "object" &&
    normalizedSessionRef !== null
      ? (normalizedSessionRef as Record<string, unknown>).ref
      : undefined;

  return {
    backend: record.engine,
    refKind: record.engine === "claude" ? "conversation" : "backend",
    lane: record.lane,
    contextId: record.contextId,
    ...(record.workflowConversationId !== undefined ||
    legacyConversationId !== undefined
      ? {
          workflowConversationId:
            record.workflowConversationId ?? legacyConversationId,
        }
      : {}),
    ...(normalizedSessionRef !== undefined
      ? { sessionRef: normalizedSessionRef }
      : {}),
    metrics: {
      ...(contextTokens !== undefined ? { contextTokens } : {}),
      ...(contextWindowMax !== undefined ? { contextWindowMax } : {}),
      ...(lastTurnUsage !== undefined ? { lastTurnUsage } : {}),
      rotateBeforeNextTurn: record.rotateBeforeNextTurn ?? false,
    },
    limitEvaluation: record.limitEvaluation,
    lastUsedAt: record.lastUsedAt,
  };
}

export const graphWorkflowAgentSessionStateSchema = z.preprocess(
  normalizeLegacyGraphLane,
  z.object({
    lane: graphWorkflowLaneKindSchema,
    contextId: z.string().trim().min(1),
    // Which use-site assignment owns this lane. Additive and optional: the
    // implementer lane is per-context (one implementer per context stands) and
    // rows written before cohorts existed carry no assignment. Validator lanes
    // set it, and it agrees with the `laneStates` key by construction — the key
    // is the addressing form, this is the record's own account of itself.
    assignmentId: z.string().trim().min(1).optional(),
    // Everything about the owning assignment a live lane has already baked in
    // (see `assignmentFingerprint`). Rotation compares it: an assignment edited
    // under a running execution must not keep replaying the superseded
    // instructions on a resumed handle. Absent means "unknown, do not rotate",
    // so legacy lanes are left alone until their next natural rotation.
    assignmentFingerprint: z.string().min(1).optional(),
    backend: agentBackendSchema,
    refKind: z.enum(["conversation", "backend"]),
    workflowConversationId: z.string().trim().min(1).optional(),
    sessionRef: graphWorkflowExecutionSessionRefSchema.optional(),
    metrics: laneMetricsSchema,
    limitEvaluation: z.enum([
      "disabled",
      "supported",
      "unsupported",
      "metrics_unavailable",
    ]),
    lastUsedAt: z.string(),
  }),
);
export type GraphWorkflowAgentSessionState = z.infer<
  typeof graphWorkflowAgentSessionStateSchema
>;

// ============================================================
// Graph Workflow Execution (root runtime record)
// ============================================================

// Advisory lane plan computed at execution seed time. Persists the
// deterministic continuation choice the scheduler should make at each
// One plan-repair attempt (docs/design/cc-cli/08). Appended BEFORE the repair
// agent runs so a crashed round still counts toward the attempt caps; settled
// via a second mutation. The append-only log is the single source of attempt
// accounting — per-context counts are derived, and resume never resets them
// (unlike consecutiveFailureCount).
export const planRepairRoundSchema = z.object({
  seq: z.number().int().min(1),
  contextId: z.string().trim().min(1),
  haltType: z.enum([
    "circuit_breaker",
    "max_iterations",
    // A loop that exhausted its budget (D4 R12). Attempt accounting for these
    // rounds keys on `loopGroupId` under the loop's own seed-resolved policy,
    // not on the context — the halt names a pass instance that will never be
    // re-run, so counting per context would give every fresh pass a fresh
    // budget of repairs.
    "loop_limit_reached",
    // Lane drift (lightweight parallelism R8). Accounted per CONTEXT like the
    // other two context halts — the reporting member is the subject whose
    // ownership the repair widens.
    "ownership_violation",
  ]),
  /** The loop a `loop_limit_reached` round repairs; null for context halts. */
  loopGroupId: z.string().trim().min(1).nullable().default(null),
  startedAt: z.string(),
  settledAt: z.string().nullable().default(null),
  // `superseded` = the halt state changed under the agent (user resumed,
  // aborted, or edited) and the round withdrew without applying anything.
  outcome: z
    .enum(["repaired", "declined", "failed", "superseded"])
    .nullable()
    .default(null),
  planningDefect: z.boolean().nullable().default(null),
  diagnosis: z.string().nullable().default(null),
  operationCount: z.number().int().min(0).default(0),
  resumed: z.boolean().default(false),
  conversationId: z.string().nullable().default(null),
});
export type PlanRepairRound = z.infer<typeof planRepairRoundSchema>;

/**
 * One accepted loop-control edit (D4 R11.2/R12) — the audit log R12 requires an
 * exit-predicate amendment to be recorded in.
 *
 * Metadata only, like the charter amendment log: the amended predicate, cap and
 * template live on the working definition, and the per-pass provenance that
 * makes an amendment provably non-retroactive lives in the loop ledger
 * (`decisions`, `passTemplateVersions`). What survives ONLY here is the "why"
 * and the control revision it took effect at.
 */
export const loopControlAmendmentSchema = z.object({
  /** 1-based, append-only across the whole execution. */
  seq: z.number().int().min(1),
  loopGroupId: z.string().trim().min(1),
  kind: z.enum(["raise-max-passes", "amend-predicate", "edit-template"]),
  /** Mandatory on `amend-predicate` (R11); optional on the other two. */
  rationale: z.string().min(1).nullable().default(null),
  /**
   * The loop's control revision AFTER this edit — what re-decides on resume.
   * Every kind bumps it (D10), so the log and the revision never disagree.
   */
  loopControlRevision: z.number().int().min(0),
  /** The group's template version after this edit. */
  templateVersion: z.number().int().min(1),
  /** The group's pass cap after this edit. */
  maxPasses: z.number().int().min(1),
  source: z.enum(["cli", "ui", "plan-repair"]),
  amendedAt: z.string(),
});
export type LoopControlAmendment = z.infer<typeof loopControlAmendmentSchema>;

/**
 * One execution context's captured structured output (D2/D5).
 *
 * Written once, when a context carrying an authored `outputSchema` finishes and
 * its final payload clears the structured-output gate. `value` is the accepted
 * payload — always a JSON object, because the authoring-time subset walker
 * refuses any declaration whose root does not describe one — and `parse` records
 * where the gate found it, in the shared extraction vocabulary. Candidates from
 * a FAILED validation never land here; they stay in the validation-failure
 * records.
 */
export const graphWorkflowContextOutputSchema = z.object({
  value: contextOutputSchemaSchema,
  capturedAt: z.string(),
  iteration: z.number().int().min(1),
  parse: agentCallStructuredOutputParseSchema,
});
export type GraphWorkflowContextOutput = z.infer<
  typeof graphWorkflowContextOutputSchema
>;

/**
 * The CURRENT route decision of one source context (D4 decision D4).
 *
 * Bounded on purpose: at most one entry per source, replaced whenever the
 * dedup key `(sourceContextId, captureIteration, routeControlRevision)` moves.
 * The full ledger — every resolution, including a pass re-decided under an
 * amended control revision — lives in the append-only events table, which is
 * where unbounded history belongs.
 */
export const graphWorkflowRouteSettlementSchema = z.object({
  sourceContextId: z.string().trim().min(1),
  /**
   * The iteration of the capture the guards were evaluated against; null for a
   * source that captured nothing (unconditional edges, or a skipped source).
   */
  captureIteration: z.number().int().min(1).nullable().default(null),
  routeControlRevision: z.number().int().min(0),
  activatedEdgeIds: z.array(z.string().trim().min(1)).default([]),
  inactiveEdgeIds: z.array(z.string().trim().min(1)).default([]),
  omittedEdgeIds: z.array(z.string().trim().min(1)).default([]),
  settledAt: z.string(),
});
export type GraphWorkflowRouteSettlement = z.infer<
  typeof graphWorkflowRouteSettlementSchema
>;

/**
 * The permanent receipt for ONE accepted runtime graph expansion (D4 R8).
 *
 * Carries everything R8 names — initiator, rationale, added ids, payload hash —
 * so the ledger answers both directions of the audit question: what this
 * request produced, and (through `resolveExpansionProvenance`) which request
 * produced a given node. Permanent within the cumulative cap: a receipt is
 * never evicted, which is exactly what makes the cumulative context budget
 * monotone under removal.
 */
export const graphWorkflowExpansionAcceptanceReceiptSchema = z.object({
  /** The lane's single-use idempotency key, unique per invoking context. */
  requestId: z.string().trim().min(1).max(200),
  /** Canonical-JSON SHA-256 of the accepted payload; a replay must match it. */
  payloadHash: z.string().trim().length(64),
  /** The invoking context — the initiator, with the conversation that asked. */
  invokerContextId: z.string().trim().min(1),
  initiatorConversationId: z.string().trim().min(1),
  rationale: z.string().trim().min(1).max(4000),
  addedContextIds: z
    .array(z.string().trim().min(1))
    .max(EXPANSION_CAPS.contextsPerRequest),
  addedTaskIds: z
    .array(z.string().trim().min(1))
    .max(EXPANSION_CAPS.tasksPerRequest),
  rejoinContextIds: z
    .array(z.string().trim().min(1))
    .max(EXPANSION_CAPS.edgesPerRequest),
  /** The revision the acceptance committed at; a replay reports it verbatim. */
  liveRevision: z.number().int().min(1),
  acceptedAt: z.string(),
});
export type GraphWorkflowExpansionAcceptanceReceipt = z.infer<
  typeof graphWorkflowExpansionAcceptanceReceiptSchema
>;

/**
 * The receipt for ONE refused runtime graph expansion (D4 R8).
 *
 * Deliberately thinner than an acceptance: a refusal changed nothing, so the
 * only durable question it has to answer is "was this exact attempt already
 * refused, and under which code" — which is what lets a retry be re-refused
 * identically instead of re-validated. Entries live in a bounded ring, so an
 * attempt whose record has aged out is honestly re-validated as a new one.
 */
export const graphWorkflowExpansionRefusalReceiptSchema = z.object({
  requestId: z.string().trim().min(1).max(200),
  payloadHash: z.string().trim().length(64),
  invokerContextId: z.string().trim().min(1),
  refusalCode: z.string().trim().min(1).max(120),
  refusedAt: z.string(),
});
export type GraphWorkflowExpansionRefusalReceipt = z.infer<
  typeof graphWorkflowExpansionRefusalReceiptSchema
>;

/**
 * The expansion audit ledgers of one execution (D4 decision D12) — permanent
 * acceptances bounded by the cumulative context cap, and the most recent
 * refusals in a fixed-size ring. Both bounds are the enforced caps themselves
 * (`EXPANSION_CAPS`), so the persisted bound cannot drift from the runtime one.
 */
export const graphWorkflowExpansionReceiptsSchema = z.object({
  accepted: z
    .array(graphWorkflowExpansionAcceptanceReceiptSchema)
    .max(EXPANSION_CAPS.contextsPerExecution)
    .default([]),
  refusals: z
    .array(graphWorkflowExpansionRefusalReceiptSchema)
    .max(EXPANSION_CAPS.refusalRingSize)
    .default([]),
});
export type GraphWorkflowExpansionReceipts = z.infer<
  typeof graphWorkflowExpansionReceiptsSchema
>;

// ============================================================
// Loop settlement state (D4 R9/R16, decisions D7 and D8)
// ============================================================

/** One top-level property of a declared `outputSchema`. */
export const graphWorkflowOutputSchemaFieldSchema = z.object({
  name: z.string(),
  /** The declared `type`, or null when the declaration omits one. */
  type: z.string().nullable(),
  required: z.boolean(),
  description: z.string().nullable(),
});
export type GraphWorkflowOutputSchemaField = z.infer<
  typeof graphWorkflowOutputSchemaFieldSchema
>;

/**
 * One predecessor's contribution to a context's injected inputs.
 *
 * Schema-first because a loop pins its boundary inputs as a DURABLE snapshot
 * (R9): each pass's entry receives the rows the first pass's entry received,
 * long after the boundary routing edge was consumed and never cloned.
 */
export const graphWorkflowUpstreamInputSchema = z.object({
  contextId: z.string(),
  title: z.string(),
  /**
   * Whether the predecessor declares an `outputSchema` at all.
   *
   * Carried separately from `schemaFields` because a valid declaration need not
   * have a field list: a bare `{"type": "object"}` and a root `oneOf` both
   * constrain the payload while naming no top-level properties. Reading
   * "declared" off `schemaFields !== null` would report those contexts as
   * free-form, which is the opposite of what they are.
   */
  declared: z.boolean(),
  /** The declared top-level fields; null when the declaration names none. */
  schemaFields: z.array(graphWorkflowOutputSchemaFieldSchema).nullable(),
  /** null when nothing is banked — free-form, or declared but not yet produced. */
  output: contextOutputSchemaSchema.nullable(),
  /**
   * The predecessor settled `skipped` — its branch was not taken (D4 R4.3).
   *
   * Carried instead of dropping the row, because a missing row and a not-taken
   * branch read identically to a downstream consumer: both are "no payload",
   * and only one of them is ever going to arrive. Always false on the
   * definition-tier walk, which has no execution to settle anything.
   */
  skipped: z.boolean(),
});
export type GraphWorkflowUpstreamInput = z.infer<
  typeof graphWorkflowUpstreamInputSchema
>;

/**
 * One pass's authoritative settlement decision (R16.1) — the single record type
 * loop settlement exports, and the idempotency marker the transaction keys on.
 *
 * Carries the FULL deduplication key: a pass is re-decided only when the loop's
 * control revision, the exit capture it read, or the body template version
 * moves. The complete history — including repeated re-decisions of one pass
 * under amended control revisions — lives in the append-only event log; this
 * field keeps only the latest per pass so the execution record stays bounded.
 */
export const graphWorkflowLoopDecisionRecordSchema = z.object({
  loopGroupId: z.string().trim().min(1),
  pass: z.number().int().min(1),
  loopControlRevision: z.number().int().min(0),
  templateVersion: z.number().int().min(1),
  /** The exit pass instance whose banked capture the predicate was read from. */
  exitContextId: z.string().trim().min(1),
  /** The capture's iteration; null when the exit banked nothing (halt paths). */
  exitCaptureIteration: z.number().int().min(1).nullable().default(null),
  verdict: z.enum(["satisfied", "unsatisfied", "unevaluable", "exit-skipped"]),
  outcome: z.enum(["concluded", "materialized", "halted"]),
  /** The pass this decision materialized; null on every other outcome. */
  nextPass: z.number().int().min(2).nullable().default(null),
  decidedAt: z.string(),
});
export type GraphWorkflowLoopDecisionRecord = z.infer<
  typeof graphWorkflowLoopDecisionRecordSchema
>;

/**
 * One durable pass-slot grant (decision D7). Pass 1 reserves at ACTIVATION —
 * before any pass-1 instance is eligible — and every later pass reserves inside
 * its settlement transaction before cloning, so every pass is admitted through
 * one ordered protocol a restart replays identically.
 */
export const graphWorkflowLoopSlotSchema = z.object({
  pass: z.number().int().min(1),
  state: z.enum(["reserved", "counted", "released"]),
  /** 1-based grant order across the whole ledger; replayed on restart. */
  grantOrder: z.number().int().min(1),
  grantedAt: z.string(),
});
export type GraphWorkflowLoopSlot = z.infer<typeof graphWorkflowLoopSlotSchema>;

/**
 * The bounded per-loop ledger (R16.1). Current state only: activation, the slot
 * grants, the pinned boundary snapshot, and the latest decision per pass.
 */
export const graphWorkflowLoopStateSchema = z.object({
  loopGroupId: z.string().trim().min(1),
  /**
   * `unstarted` — the external activation path has not resolved.
   * `running` — pass instances are live; the exit holds its external edges
   * unresolved so downstream cannot become eligible.
   * `concluded` — the until predicate was satisfied; external edges resolve to
   * `concludingExitContextId`.
   * `skipped` — the activation path was not taken; the loop and its body skip
   * entirely and the logical exit reads as a skipped source (R9.6).
   */
  activation: z.enum(["unstarted", "running", "concluded", "skipped"]),
  /**
   * Monotonic control revision, part of every decision record's dedup key.
   * EVERY accepted loop-control op bumps it (decision D10) — an amendment to
   * the exit predicate, a raised pass cap, and a body-template content edit
   * alike — which is what lets a repaired loop re-decide a pass it already
   * decided.
   */
  loopControlRevision: z.number().int().min(0).default(0),
  /** Passes materialized so far — the ledger's own count, not a graph scan. */
  passCount: z.number().int().min(0).default(0),
  slotLedger: z.array(graphWorkflowLoopSlotSchema).default([]),
  /**
   * The loop-boundary inputs pinned at activation. The incoming boundary edge
   * is consumed once by the first pass and never cloned, so this snapshot is
   * what carries the loop's external inputs into every later pass's entry.
   */
  boundaryInputs: z
    .array(graphWorkflowUpstreamInputSchema)
    .nullable()
    .default(null),
  /** Latest decision per pass, keyed by the pass number as a string. */
  decisions: z
    .record(z.string(), graphWorkflowLoopDecisionRecordSchema)
    .default({}),
  /**
   * The body-template version each pass CLONED, keyed by the pass number as a
   * string (R11.2). Written when the pass is materialized, so it is provenance
   * rather than a projection: a template amended between two passes leaves the
   * earlier pass reading the version it actually ran, which is what makes
   * "template edits are never retroactive" auditable after the fact.
   */
  passTemplateVersions: z
    .record(z.string(), z.number().int().min(1))
    .default({}),
  /** The concluding pass's exit instance; null until the loop concludes. */
  concludingExitContextId: z.string().trim().min(1).nullable().default(null),
  activatedAt: z.string().nullable().default(null),
  settledAt: z.string().nullable().default(null),
});
export type GraphWorkflowLoopState = z.infer<
  typeof graphWorkflowLoopStateSchema
>;

/**
 * Vocabulary of the lifecycle contract (design §10). The decision table itself
 * lives in `lifecycle-classifier.ts` — the single module allowed to decide any
 * of these — but the verdict is a schema so every consumer derives its type
 * instead of restating it.
 */
export const graphWorkflowLifecycleDecisionSchema = z.object({
  status: graphWorkflowStatusSchema,
  /**
   * Whether the run has ended. Terminality is NOT tenure: `halted` is terminal
   * (no further progress happens on its own) yet may still hold the session's
   * lease, because it is resumable. Tenure is `holdsExecutionLease`, which
   * reads the halt reason and the abandonment record a status cannot see.
   */
  terminal: z.boolean(),
});
export type GraphWorkflowLifecycleDecision = z.infer<
  typeof graphWorkflowLifecycleDecisionSchema
>;
/**
 * Where a run came from (D7 decision D2). A `template` run names the saved
 * definition and the revision it was launched from; a `one_off` run has no
 * definition record anywhere — its authored source is `launchDocument` and its
 * only human-facing identity is the submitted plan name.
 *
 * Provenance, not a dependency: nothing here is resolved against stored
 * definitions at read time, which is what lets a historical run render after
 * its template is edited or deleted. A one-off row additionally writes
 * legacy-shaped filler into the seed fields so an older build's eager
 * `listActive()` still parses it (see `execution-origin.ts`); every consumer
 * branches on THIS field and never on that filler.
 */
export const graphWorkflowExecutionOriginSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("template"),
    definitionId: z.string().trim().min(1),
    definitionRevision: z.number().int().min(1),
    tier: z.enum(["project", "global"]),
  }),
  z.object({
    kind: z.literal("one_off"),
    planName: z.string().trim().min(1),
  }),
]);
export type GraphWorkflowExecutionOrigin = z.infer<
  typeof graphWorkflowExecutionOriginSchema
>;

/**
 * What an ACCEPTED launch tells its caller (D7 R1.2, decision D1).
 *
 * Two dispositions, both successes: the run began, or it parked awaiting
 * definition approval — durable, holding the session's lease, and waiting on a
 * human. `pending` is deliberately absent: a launch receipt reports what the
 * caller must do next, and "pending" answers that only by accident.
 */
export const graphWorkflowLaunchStatusSchema = z.enum([
  "running",
  "awaiting_definition_approval",
]);
export type GraphWorkflowLaunchStatus = z.infer<
  typeof graphWorkflowLaunchStatusSchema
>;

/**
 * THE launch receipt, returned by both launch transports.
 *
 * Addressed by execution identity and origin alone — a one-off run has no
 * definition id to report and a template run's identity already lives in its
 * origin, so no surface has to know which verb produced the run it is rendering.
 */
export const graphWorkflowLaunchReceiptSchema = z.object({
  executionId: z.string().trim().min(1),
  status: graphWorkflowLaunchStatusSchema,
  origin: graphWorkflowExecutionOriginSchema,
  originConversationId: z.string().trim().min(1).nullable(),
  deepLink: z.string().trim().min(1),
  startedAt: z.string(),
});
export type GraphWorkflowLaunchReceipt = z.infer<
  typeof graphWorkflowLaunchReceiptSchema
>;

/**
 * THE receipt every execution-addressed lifecycle act answers with — abandon,
 * definition approval, definition rejection (D7 R4.1, R14.2).
 *
 * Built from the execution's recorded origin for the same reason the launch
 * receipt is: the seed fields on a one-off row are legacy-shaped filler, and an
 * act addressed by execution id alone must not hand that filler back as the
 * identity of a definition the run does not have. `archived` says whether the
 * act relocated the run into History, which is the one thing the acts differ on
 * that a caller acts upon.
 */
export const graphWorkflowExecutionActReceiptSchema = z.object({
  executionId: z.string().trim().min(1),
  status: graphWorkflowStatusSchema,
  origin: graphWorkflowExecutionOriginSchema,
  archived: z.boolean(),
});
export type GraphWorkflowExecutionActReceipt = z.infer<
  typeof graphWorkflowExecutionActReceiptSchema
>;

/**
 * What the caller of a refused launch should do about the run that holds the
 * lease (D7 decision D6). Derived from the same admission decision that
 * refused — never chosen by the surface rendering it, which is how the CLI
 * text, the JSON envelope, and the UI say the same thing.
 */
export const graphWorkflowLeaseRemedySchema = z.enum([
  // The lease holder is parked awaiting definition approval: decide it or end
  // the run. Pausing a run that has not started would say nothing.
  "approve_or_abort",
  // The lease holder is live (pending-unparked, running, or paused). Look at
  // what it is doing before ending it.
  "inspect_or_pause",
  // The lease holder is a resumable halt: finish it or explicitly abandon it.
  "resume_or_abandon",
]);
export type GraphWorkflowLeaseRemedy = z.infer<
  typeof graphWorkflowLeaseRemedySchema
>;

/**
 * The facts a refusal names about the lease holder. Assembled by the admission
 * decision from the incumbent record alone — a claimed id never reaches it.
 */
export const graphWorkflowLeaseIncumbentSchema = z.object({
  executionId: z.string().trim().min(1),
  status: graphWorkflowStatusSchema,
  origin: graphWorkflowExecutionOriginSchema,
  originConversationId: z.string().trim().min(1).nullable(),
});
export type GraphWorkflowLeaseIncumbent = z.infer<
  typeof graphWorkflowLeaseIncumbentSchema
>;

/**
 * THE launch-refusal payload (D7 decision D6): the incumbent facts, the remedy
 * the lease decision implies, and the deep link that addresses the run. One
 * shape serves every launch refusal — the project-scope and nesting refusals
 * carry the same envelope with no blocker, because they have no incumbent to
 * name rather than a different payload.
 */
export const graphWorkflowLeaseBlockerSchema =
  graphWorkflowLeaseIncumbentSchema.extend({
    remedy: graphWorkflowLeaseRemedySchema,
    deepLink: z.string().trim().min(1),
  });
export type GraphWorkflowLeaseBlocker = z.infer<
  typeof graphWorkflowLeaseBlockerSchema
>;

/**
 * The authored document a run was launched from, snapshotted once at seed
 * (D7 decision D13): the submitted `{name, description, definition, layout}`
 * for a one-off run, and the template record's same four fields for a template
 * run. This is the pre-substitution, pre-cascade source — `workingDefinition`
 * carries the final edited state — plus the durable name, description, and
 * layout History renders from with no reference to any saved template.
 */
export const graphWorkflowLaunchDocumentSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().trim().min(1).nullable().default(null),
  definition: workflowSemanticDefinitionSchema,
  layout: graphWorkflowVisualLayoutSchema,
});
export type GraphWorkflowLaunchDocument = z.infer<
  typeof graphWorkflowLaunchDocumentSchema
>;

/**
 * The audit an explicit abandon writes (D7 decision D5). Status stays `halted`
 * — the run's final engine state is a fact — and the Abandoned disposition is
 * derived from the presence of this record, which is also what ends the run's
 * lease. The admitted actors are a human UI caller and the origin conversation
 * under its verified identity, so the actor carries that identity rather than a
 * free-text label nobody can attribute afterwards.
 */
export const graphWorkflowAbandonmentSchema = z.object({
  abandonedAt: z.string(),
  actor: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("human") }),
    z.object({
      kind: z.literal("conversation"),
      conversationId: z.string().trim().min(1),
    }),
  ]),
  reason: z.string().trim().min(1),
});
export type GraphWorkflowAbandonment = z.infer<
  typeof graphWorkflowAbandonmentSchema
>;

export const graphWorkflowExecutionSchema = z.object({
  id: z.string().trim().min(1),
  // Required with no schema default: absence is floored ONCE, at the stored-row
  // decode boundary (`decodeGraphWorkflowExecution`), where the seed fields are
  // available to derive the template origin a pre-D7 row implies. A schema
  // default could not see them, and an optional field would be a second
  // compatibility surface for every consumer to re-handle.
  origin: graphWorkflowExecutionOriginSchema,
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  // Written once at seed and never rewritten — it lives in the definition tier
  // beside the other seed-time audit fields. `.default(null)` floors rows
  // written before the snapshot existed; those runs render at whatever fidelity
  // they actually persisted rather than being blocked or back-filled.
  launchDocument: graphWorkflowLaunchDocumentSchema.nullable().default(null),
  // Set by the abandon act and never cleared. `.default(null)` floors every row
  // written before the act existed to "not abandoned", which is what they were.
  abandonment: graphWorkflowAbandonmentSchema.nullable().default(null),
  // Pinned at launch when the dirty-worktree exemption admitted this run
  // (D7 decision D10), and re-asserted by the live-edit frontier for the whole
  // execution lifetime. A clean-worktree launch pins nothing, and so does every
  // row written before the exemption existed — hence the `false` floor.
  liveSessionReadOnlyPinned: z.boolean().default(false),
  // Optimistic-concurrency token for live edits (doc 06, D4). A bounded scalar
  // counter incremented ONLY by accepted live-edit batches (including the
  // lane-agent `add_task`), never by scheduler ticks, so `baseLiveRevision`
  // guards catch edit-vs-edit lost updates. Persisted in the runtime tier
  // (`RUNTIME_TIER_KEYS`); rows written before the field existed parse as `1`.
  liveRevision: z.number().int().min(1).default(1),
  // Repository-owned staging fence (D4, decision D5). A monotonic counter the
  // execution repository bumps on EVERY committed `mutateActive` — scheduler
  // ticks, lane writes, and live edits alike — so a slow caller can capture it
  // with a snapshot outside the lock and detect, inside the lock, that anything
  // at all committed in between. `liveRevision` cannot serve here: it moves only
  // on accepted live edits, so a scheduler write between prepare and finalize
  // would be invisible to it and get erased by a whole-state install. A reducer
  // never sets this; the repository overwrites whatever it returns. Persisted in
  // the runtime tier; rows written before the field existed parse as `0`.
  executionStateRevision: z.number().int().min(0).default(0),
  // Repository-owned STRUCTURAL fence (D4, decision D5) — the spec's "definition
  // fingerprint". A monotonic counter the execution repository bumps on a
  // committed `mutateActive` whose `STRUCTURAL_REVISION_KEYS` actually moved, so
  // the staging seam can decide in O(1) whether the graph it validated against is
  // still the graph it would install onto. Derived by comparison rather than
  // declared by each writer: `liveRevision` moves only on accepted live edits, so
  // a runtime writer that appends to `workingDefinition` (script-validator
  // remediation tasks) is invisible to it and would be erased by a wholesale
  // install. A reducer never sets this; the repository overwrites whatever it
  // returns. Persisted in the runtime tier; rows written before the field existed
  // parse as `0`.
  structuralRevision: z.number().int().min(0).default(0),
  // Append-only metadata log of accepted live `amend-charter` operations
  // (docs/design/cc-cli/07). The current charter content lives in
  // `execution.charter`; this records seq/when/who/why/what-changed per
  // amendment. Persisted in the runtime tier; rows written before the field
  // existed parse as `[]`.
  charterAmendments: z.array(charterAmendmentSchema).default([]),
  // Append-only plan-repair attempt log (docs/design/cc-cli/08, roadmap D1).
  // Persisted in the runtime tier; rows written before the field existed parse
  // as `[]`.
  planRepairRounds: z.array(planRepairRoundSchema).default([]),
  // Append-only audit log of accepted loop-control edits (D4 R11.2/R12). The
  // current cap, predicate and template live on the working definition; this
  // records who moved them, when, and — for the amendment R11 demands one of —
  // why. Persisted in the runtime tier; rows written before the field existed
  // parse as `[]`.
  loopControlAmendments: z.array(loopControlAmendmentSchema).default([]),
  // Loop-generation fence token. Incremented ONLY by `resume()` — every resume
  // starts a new loop generation, and any execution loop still alive from a
  // prior generation (a "zombie" blocked in a long await across the
  // halt/resume) fails its fence check on the next read or write instead of
  // racing the new loop. Persisted in the runtime tier; rows written before
  // the field existed parse as `0`.
  loopEpoch: z.number().int().min(0).default(0),
  // Raw bound-input snapshot recording which parameter values produced the run.
  // All supported parameter types (string/text/enum) bind to string values, so
  // the value type is `string`. `.default({})` lets legacy execution rows that
  // predate parameter support parse back as zero-input audit shape (R6.5, R10.2).
  boundInputs: z.record(z.string(), z.string()).default({}),
  // Additive audit annotation recording the tier the template was launched
  // from. `.default("project")` lets legacy execution rows that predate the
  // global tier parse back as project-tier launches (R3.3, R9.3).
  launchedTier: z.enum(["project", "global"]).default("project"),
  // The conversation that launched this run, captured SERVER-SIDE at the start
  // seam (a request-body claim is never a source) and fixed at seed. It is the
  // only identity that can act on an execution with no lanes yet — the
  // validation resolver admits exactly this conversation and refuses every
  // other. `.default(null)` floors rows written before the field existed to an
  // unowned run, which the resolver treats as fail-closed rather than open.
  ownerConversationId: z.string().trim().min(1).nullable().default(null),
  definitionApproval: graphWorkflowDefinitionApprovalSchema
    .nullable()
    .default(null),
  // The in-flight half of a definition decision. `.default(null)` floors rows
  // written before the field existed to "no decision in flight", which is the
  // steady state of every park nobody is deciding right now.
  definitionApprovalClaim: graphWorkflowDefinitionApprovalClaimSchema
    .nullable()
    .default(null),
  workingDefinition: resolvedWorkflowSemanticDefinitionSchema,
  charter: workflowCharterSchema,
  status: graphWorkflowStatusSchema,
  activeContextIds: z.array(z.string()).default([]),
  contextStates: z
    .record(z.string(), graphWorkflowExecutionContextStateSchema)
    .default({}),
  taskStates: z.record(z.string(), graphWorkflowTaskStateSchema).default({}),
  // Captured structured outputs keyed by execution-context id (D2/D5) — at most
  // one entry per context carrying an authored `outputSchema`. Persisted in the
  // runtime tier; rows written before the field existed parse as `{}`, which is
  // also the steady state for a workflow whose contexts declare no schema.
  contextOutputs: z
    .record(z.string(), graphWorkflowContextOutputSchema)
    .default({}),
  // Per-source monotonic route-control revision (D4, decision D2), keyed by
  // execution-context id. Bumped by the shared mutation seam whenever a source's
  // outgoing conditional edges or `routing.cardinality` change, and part of the
  // route-settlement deduplication key so a guard set edited A→B→A still
  // re-settles. Persisted in the runtime tier; rows written before the field
  // existed parse as `{}`, which is also the steady state for a workflow whose
  // edges carry no guards.
  routeControlRevisions: z
    .record(z.string(), z.number().int().min(0))
    .default({}),
  // Current route decision per SOURCE context (D4, decision D4), keyed by
  // execution-context id — bounded to one entry per source. Written
  // exactly-once per `(source, captureIteration, routeControlRevision)` in the
  // same mutation that publishes the route-resolved event. Persisted in the
  // runtime tier; rows written before the field existed parse as `{}`, which is
  // also the steady state for a workflow whose edges carry no guards.
  routeSettlements: z
    .record(z.string(), graphWorkflowRouteSettlementSchema)
    .default({}),
  // Runtime-expansion audit ledgers (D4, decision D12): permanent acceptance
  // receipts bounded by the cumulative context cap, plus a 20-entry ring of the
  // most recent refusals. Both halves are load-bearing rather than
  // observational — an acceptance receipt is what a repeated (invoker,
  // requestId, payload hash) replays instead of mutating the graph twice, and a
  // retained refusal is what re-refuses a retry identically. Persisted in the
  // runtime tier; rows written before the field existed parse as empty ledgers,
  // which is also the steady state for an execution no lane ever expanded.
  expansionReceipts: graphWorkflowExpansionReceiptsSchema.default({
    accepted: [],
    refusals: [],
  }),
  // Per-loop-group settlement ledger (D4 R9/R16), keyed by loop group id —
  // bounded to one entry per DECLARED group, so a workflow with no loops keeps
  // an empty map. Written only by the loop-settlement transaction. Persisted in
  // the runtime tier; rows written before the field existed parse as `{}`,
  // which is also the steady state for a loop-free workflow.
  loopStates: z.record(z.string(), graphWorkflowLoopStateSchema).default({}),
  sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).default([]),
  // Every `plan` and `out_of_scope` advisory raised anywhere in this execution,
  // projected out of the per-round records so its audience reads one list
  // instead of opening rounds (R9, D9). Maintained as each lane's advisories are
  // stamped, so a round that later fails still contributes what it observed.
  // Persisted in the runtime tier; rows written before the field existed parse
  // as `[]`, which is also the steady state for a run whose validators raised
  // nothing that outlives its round.
  advisoryIndex: z.array(graphWorkflowAdvisoryIndexEntrySchema).default([]),
  laneStates: z
    .record(
      z.string(),
      z.record(z.string(), graphWorkflowAgentSessionStateSchema),
    )
    .default({}),
  executionLanes: z
    .record(z.string(), graphWorkflowExecutionLaneStateSchema)
    .default({}),
  /**
   * Lanes claimed by an in-flight scheduling batch, keyed by lane id. Empty in
   * the steady state: a reservation exists only between a batch's reserve and
   * its finalize (or its compensating release).
   */
  laneReservations: z
    .record(z.string(), graphWorkflowLaneReservationSchema)
    .default({}),
  joins: z
    .record(z.string(), graphWorkflowExecutionJoinStateSchema)
    .default({}),
  machineSnapshot: z.unknown().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  pendingHaltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  secondaryHaltReasons: z.array(graphWorkflowHaltReasonSchema).default([]),
  pendingCollaborations: z
    .record(z.string(), graphWorkflowPendingCollaborationSchema)
    .default({}),
  collaborationContinuations: z
    .record(z.string(), z.array(graphWorkflowCollaborationContinuationSchema))
    .default({}),
  pendingMergeRetry: z.array(z.string().trim().min(1)).default([]),
});
export type GraphWorkflowExecution = z.infer<
  typeof graphWorkflowExecutionSchema
>;

/**
 * Where a recorded boundary result stands with its origin conversation (D7
 * decision D8). The three states are the message queue's proven claim/recover/
 * settle shape applied to a ledger that is deliberately NOT a message: nothing
 * here ever enters the pending-message queue or starts an agent turn.
 *
 * `delivering` is a CLAIM, not an outcome — a turn that dies before
 * acknowledgment leaves it here, and rehydration recovery returns it to
 * `pending` so the same boundary re-presents under its stable identity.
 */
export const graphWorkflowResultDeliveryStateSchema = z.enum([
  "pending",
  "delivering",
  "delivered",
]);
export type GraphWorkflowResultDeliveryState = z.infer<
  typeof graphWorkflowResultDeliveryStateSchema
>;

/**
 * One lifecycle boundary's durable result record for its origin conversation
 * (D7 decision D8), written in the same transaction as the boundary's event
 * append. `(executionId, boundarySeq)` is the identity: the boundary cursor is
 * the durable event row id, so a replayed recording collides with itself rather
 * than delivering the same result twice.
 *
 * `payload` is the boundary's result projection, opaque at this layer — the
 * projection that builds it owns its shape, and the record-time size cap
 * replaces any single over-large declared output with a reference to the value
 * that already persists durably in the execution's `contextOutputs`.
 */
export const graphWorkflowResultDeliverySchema = z.object({
  executionId: z.string().trim().min(1),
  boundarySeq: z.number().int().min(1),
  projectPath: z.string().trim().min(1),
  sessionName: z.string().trim().min(1),
  originConversationId: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()),
  recordedAt: z.string(),
  state: graphWorkflowResultDeliveryStateSchema.default("pending"),
  // The claiming turn's attempt id, cleared when recovery releases the claim.
  attemptId: z.string().trim().min(1).nullable().default(null),
  attemptCount: z.number().int().min(0).default(0),
  deliveredAt: z.string().nullable().default(null),
  effectsDeliveredAt: z.string().nullable().default(null),
});
export type GraphWorkflowResultDelivery = z.infer<
  typeof graphWorkflowResultDeliverySchema
>;

/**
 * A document the launching tier hands the engine to seed into a run: content
 * the tier already rendered, at a worktree-relative path under the shared
 * document directory. Deliberately opaque — the engine never learns what the
 * bytes mean, so no launching tier's vocabulary reaches this layer.
 */
export const seededWorkflowDocumentSchema = z.object({
  relativePath: z.string().trim().min(1),
  contents: z.string(),
  description: z.string(),
  readWhen: z.string(),
});
export type SeededWorkflowDocument = z.infer<
  typeof seededWorkflowDocumentSchema
>;

/**
 * The reserved-but-not-yet-materialized artifacts of one execution, recorded in
 * the SAME transaction that installs the winner's row.
 *
 * A launch's `.cc` writes deliberately happen AFTER the lease CAS commits
 * (`reserve-before-side-effects`), which opens a window: a crash between the
 * commit and the writes leaves a durable execution whose charter and seeded
 * documents are missing from the worktree, and whose seeded CONTENTS exist
 * nowhere — the execution record carries only their registrations. This record
 * is that missing reconstruction data, and its mere presence is the "artifacts
 * are not known-materialized" marker a later kickoff retries from. It is
 * deleted once materialization succeeds, so it is transient rather than a
 * second copy of the run's documents.
 *
 * Its own table, not a field on the execution: the contents are launch-sized
 * and would otherwise inflate the execution blob every read decodes, for data
 * that is meaningless minutes after the launch.
 */
export const graphWorkflowPendingArtifactsSchema = z.object({
  executionId: z.string().trim().min(1),
  projectPath: z.string().trim().min(1),
  sessionName: z.string().trim().min(1),
  documents: z.array(seededWorkflowDocumentSchema),
  recordedAt: z.string(),
});
export type GraphWorkflowPendingArtifacts = z.infer<
  typeof graphWorkflowPendingArtifactsSchema
>;

/**
 * One entry of a session's execution history, as the HISTORY endpoint projects
 * it. A narrow client contract over `GraphWorkflowExecutionSummary`: the fields
 * a past run's list row actually shows, so the history list never has to load
 * whole archived execution blobs. `haltReason` is what makes an ended run
 * explain itself — including a cutover abort, which is the only record an
 * operator has that their in-flight run was ended by the migration.
 */
export const graphWorkflowExecutionHistoryItemSchema = z.object({
  executionId: z.string(),
  definitionId: z.string(),
  definitionRevision: z.number(),
  status: graphWorkflowStatusSchema,
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  haltReason: graphWorkflowHaltReasonSchema.nullable().default(null),
  archived: z.boolean().default(false),
});
export type GraphWorkflowExecutionHistoryItem = z.infer<
  typeof graphWorkflowExecutionHistoryItemSchema
>;

export const graphWorkflowExecutionFullResponseSchema = z.object({
  execution: graphWorkflowExecutionSchema.nullable(),
});

export type GraphWorkflowExecutionFullResponse = z.infer<
  typeof graphWorkflowExecutionFullResponseSchema
>;

export const resetExecutionContextRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
});

/**
 * Reset ONE cohort member rather than the whole context (R8.3). The assignment
 * id is required: an absent one would silently widen the request into the far
 * more destructive whole-context reset.
 */
export const resetExecutionContextAssignmentRequestSchema = z.object({
  executionId: z.string().trim().min(1),
  contextId: z.string().trim().min(1),
  assignmentId: z.string().trim().min(1),
});
