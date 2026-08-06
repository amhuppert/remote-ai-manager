import { z } from "zod";
import {
  conflictDecisionInputSchema,
  conflictEntrySchema,
  deliveryGateHaltReasonSchema,
} from "@/lib/jobs/schemas";
import {
  askQuestionAnswerSchema,
  askQuestionItemSchema,
} from "@/lib/conversations/schemas";
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
  resolvedWorkflowSemanticDefinitionSchema,
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
    // non-terminal run's resume path; `summary` explains that in the inspector,
    // mirroring the `max_iterations.summary` precedent. Additive — a
    // user-initiated abort (and every pre-cutover row) parses as null, and
    // resumability is unchanged: an abort is terminal whatever caused it.
    cause: z.enum(["migration_cutover"]).nullable().default(null),
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
  status: graphWorkflowExecutionJoinStatusSchema,
  errorMessage: z.string().nullable().default(null),
  conflicts: graphWorkflowExecutionJoinConflictDetailSchema
    .nullable()
    .default(null),
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

export const graphWorkflowPendingApprovalSchema = z.object({
  conversationId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
  decision: graphWorkflowApprovalDecisionSchema.nullable().default(null),
});
export type GraphWorkflowPendingApproval = z.infer<
  typeof graphWorkflowPendingApprovalSchema
>;

export const graphWorkflowDefinitionApprovalSchema = z.object({
  requestedAt: z.string().trim().min(1),
  approvedAt: z.string().trim().min(1).nullable().default(null),
});
export type GraphWorkflowDefinitionApproval = z.infer<
  typeof graphWorkflowDefinitionApprovalSchema
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
 * `candidateTreeHash` is the git tree written from the SAME temporary index the
 * diff pipeline builds (`computeCandidateTreeHash`), so untracked content and
 * file modes are inside the identity while gitignored build artifacts and lane
 * logs are outside it — coextensive with what the validators actually see.
 * `headSha` pins the base commit and `taskStateHash` covers the context's task
 * tuples, so a task completed or reopened mid-round moves the identity too.
 *
 * All three components are required. A round exists to make "every specialist
 * judged THIS tree" checkable, and an identity with a missing tree component
 * cannot support that claim — so an unresolvable tree is an infrastructure
 * outcome that prevents the round from opening, never a candidate with holes in
 * it that later compares equal to itself.
 */
export const graphWorkflowValidationCandidateSchema = z
  .object({
    headSha: z.string().trim().min(1),
    candidateTreeHash: z.string().trim().min(1),
    taskStateHash: z.string().trim().min(1),
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

export const graphWorkflowValidationSpecialistSchema = z
  .object({
    state: graphWorkflowValidationSpecialistStateSchema,
    attempts: z.number().int().min(0).default(0),
    summary: z.string().nullable().default(null),
    issues: z.array(workflowValidatorIssueSchema).default([]),
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

// ============================================================
// Graph Workflow Context + Task State
// ============================================================

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
  haltType: z.enum(["circuit_breaker", "max_iterations"]),
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

// fan-out point so restarts make the same call. See
// `src/lib/workflow-graph/lane-plan.ts`.
const graphWorkflowLanePlanSchema = z.object({
  continuationMap: z.record(z.string(), z.string()).default({}),
  longestDownstreamPath: z
    .record(z.string(), z.number().int().min(0))
    .default({}),
});

export const graphWorkflowExecutionSchema = z.object({
  id: z.string().trim().min(1),
  seedDefinitionId: z.string().trim().min(1),
  seedDefinitionRevision: z.number().int().min(1),
  // Optimistic-concurrency token for live edits (doc 06, D4). A bounded scalar
  // counter incremented ONLY by accepted live-edit batches (including the
  // lane-agent `add_task`), never by scheduler ticks, so `baseLiveRevision`
  // guards catch edit-vs-edit lost updates. Persisted in the runtime tier
  // (`RUNTIME_TIER_KEYS`); rows written before the field existed parse as `1`.
  liveRevision: z.number().int().min(1).default(1),
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
  definitionApproval: graphWorkflowDefinitionApprovalSchema
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
  sharedDocuments: z.array(graphWorkflowSharedDocumentEntrySchema).default([]),
  laneStates: z
    .record(
      z.string(),
      z.record(z.string(), graphWorkflowAgentSessionStateSchema),
    )
    .default({}),
  executionLanes: z
    .record(z.string(), graphWorkflowExecutionLaneStateSchema)
    .default({}),
  joins: z
    .record(z.string(), graphWorkflowExecutionJoinStateSchema)
    .default({}),
  lanePlan: graphWorkflowLanePlanSchema.default({
    continuationMap: {},
    longestDownstreamPath: {},
  }),
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
