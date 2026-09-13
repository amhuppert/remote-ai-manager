import { z } from "zod";
import { registerTrustedSchema } from "@/lib/shared/parse-trusted";
import { agentFailureClassificationSchema } from "@/lib/agent-backends/errors";
import { mergeIntentSourceSchema } from "@/lib/merge-intents/schemas";

export const jobTypeSchema = z.enum([
  "commit",
  "merge",
  "resolve-conflicts",
  "rebase",
]);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "conflicts",
  "ready-to-land",
  "discarded",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const candidateValidationFactSchema = registerTrustedSchema(
  z
    .object({
      validationRef: z.string().min(1),
      validatedSha: z.string().min(1),
      validatedTreeHash: z.string().min(1),
      commandIdentity: z.string().min(1),
      outcome: z.enum(["pass", "fail"]),
    })
    .strict(),
  "candidateValidationFactSchema",
);
export type CandidateValidationFact = z.infer<
  typeof candidateValidationFactSchema
>;

export const deliveryGateCriterionOutcomeSchema = z.object({
  criterionId: z.string().min(1),
  criterionHandle: z.string().min(1),
  outcome: z.string().min(1),
  reason: z.string().optional(),
  automated: z.array(z.string()).optional(),
});

export const deliveryGateHaltReasonSchema = z.object({
  type: z.literal("delivery_gate_failed"),
  unmet: z.array(deliveryGateCriterionOutcomeSchema),
  instruction: z.string().min(1),
  /**
   * Present only when the refusal is the gate waiting on a human delivery
   * approval; halt surfaces render it as an attention (amber) state with an
   * approval deep link instead of the unmet-criteria failure template.
   * Optional so halt reasons persisted before this field parse unchanged.
   */
  refusalCode: z.literal("approval_required").optional(),
  /** Owning-spec presentation for the halt surface's Controls deep link. */
  spec: z
    .object({
      specSlug: z.string().min(1),
      specName: z.string().min(1),
      projectName: z.string().min(1),
    })
    .strict()
    .optional(),
});
export type DeliveryGateHaltReason = z.infer<
  typeof deliveryGateHaltReasonSchema
>;

/**
 * The conflict resolver never reached the conflict: the backend failed, the
 * quota was exhausted, the turn was aborted or timed out, or no schema-valid
 * output survived. `conflictFiles` is the merge's context for the halt, not an
 * accusation about their content — nothing read them.
 */
export const resolutionInfrastructureHaltReasonSchema = z.object({
  type: z.literal("resolution_infrastructure"),
  failure: agentFailureClassificationSchema,
  conflictFiles: z.array(z.string()),
});
export type ResolutionInfrastructureHaltReason = z.infer<
  typeof resolutionInfrastructureHaltReasonSchema
>;

/**
 * Every machine-readable refusal a merge-family job can terminate with. New
 * variants must land here and in the merge domain's twin
 * (`workflows/merge/types.ts`) together — the SSE frame is parsed against this
 * schema on the client, so a variant missing here is a dropped event, not a
 * degraded one.
 */
export const mergeHaltReasonSchema = z.discriminatedUnion("type", [
  deliveryGateHaltReasonSchema,
  resolutionInfrastructureHaltReasonSchema,
]);
export type MergeHaltReason = z.infer<typeof mergeHaltReasonSchema>;

// Documented phase strings (held as z.string() for forward compatibility):
//   "committing-uncommitted" | "merging-main" | "analyzing-conflicts" |
//   "resolving-conflicts" | "validating" | "fixing-validation" |
//   "re-validating" | "preparing" | "publishing" | "awaiting-land"
// Phase-clearing rule: phase is cleared on terminal transitions to completed,
// failed, conflicts, or discarded; phase "awaiting-land" is retained on
// ready-to-land terminal entry.
export const backgroundJobSchema = registerTrustedSchema(
  z.object({
    jobId: z.string(),
    jobType: jobTypeSchema,
    status: jobStatusSchema,
    projectName: z.string(),
    sessionName: z.string(),
    branchName: z.string(),
    targetBranch: z.string().optional(),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    mergeHash: z.string().optional(),
    commitHash: z.string().optional(),
    conflictCount: z.number().optional(),
    conflictFiles: z.array(z.string()).optional(),
    errorMessage: z.string().optional(),
    phase: z.string().optional(),
    parkedRef: z.string().optional(),
    preparedSha: z.string().optional(),
    expectedTargetSha: z.string().optional(),
    refreshWarning: z.string().optional(),
    /**
     * The merge had nothing to land: the target already contained the branch,
     * so the run completed without a commit and `mergeHash` stays absent.
     * Optional because every other job kind — and every merge that did land —
     * simply omits it.
     */
    upToDate: z.boolean().optional(),
    executionId: z.string().optional(),
    specExecutionId: z.string().optional(),
    finalPublish: z.boolean().optional(),
    candidateValidation: candidateValidationFactSchema.optional(),
    haltReason: mergeHaltReasonSchema.optional(),
    /**
     * When the job last reported movement — a status broadcast or a durable
     * progress write. Stale recovery measures inactivity against it rather
     * than total runtime, so a long merge that is still advancing is never
     * torn down. Optional because the live job registry outlives a module
     * reload: a job registered by an earlier build carries no stamp, and
     * readers fall back to `startedAt`.
     */
    lastProgressAt: z.string().optional(),
    // Agent-written intent notes for the conflict resolver, stamped at
    // dispatch: a resolve-conflicts retry after a conflicts terminal and a land
    // re-entry after a restart both reuse them.
    resolutionContext: z.string().optional(),
    /**
     * Whether this merge-family job's publish also finalizes the session
     * (`MergeContext.finalizeSessionOnPublish`), stamped at dispatch from the
     * same resolved value the machine receives.
     *
     * Carried as an explicit fact because the workflow launch guard reads it:
     * only a session-finalizing merge makes a session exclusively busy, and
     * jobType cannot tell one from a graph lane merge — the engine runs those
     * itself, so inferring from jobType would have the engine block its own
     * work. Absent on commit and rebase jobs, which publish nothing.
     */
    finalizeSessionOnPublish: z.boolean().optional(),
    skipMarkMerged: z.boolean().optional(),
    /**
     * Which surface dispatched this merge, stamped at dispatch. The intent
     * brief a completed merge attaches to its landed commit is attributed from
     * it, so the attribution follows the dispatch rather than being restated
     * (and contradicted) by whoever hosts the machine. Absent on commit and
     * rebase jobs, which land no merge.
     */
    intentSource: mergeIntentSourceSchema.optional(),
  }),
  "backgroundJobSchema",
);
export type BackgroundJob = z.infer<typeof backgroundJobSchema>;

/**
 * The durable half of a job. Jobs themselves stay ephemeral (plan D12) — no
 * machine actor survives a restart — but a `ready-to-land` job parks a real
 * commit under `refs/cc-merges/` and hands the operator a decision, so the
 * bookkeeping a land or discard re-entry needs (`parkedRef`, `preparedSha`,
 * `expectedTargetSha`, `finalizeSessionOnPublish`, `resolutionContext`) has to
 * outlive the in-memory registry the decision would otherwise be read from.
 */
export const jobRecordSchema = registerTrustedSchema(
  backgroundJobSchema
    .pick({
      jobId: true,
      jobType: true,
      status: true,
      projectName: true,
      sessionName: true,
      branchName: true,
      startedAt: true,
      completedAt: true,
      mergeHash: true,
      commitHash: true,
      conflictCount: true,
      conflictFiles: true,
      errorMessage: true,
      executionId: true,
      specExecutionId: true,
      finalPublish: true,
      parkedRef: true,
      preparedSha: true,
      expectedTargetSha: true,
      finalizeSessionOnPublish: true,
      skipMarkMerged: true,
      resolutionContext: true,
      candidateValidation: true,
    })
    .strict(),
  "jobRecordSchema",
);
export type JobRecord = z.infer<typeof jobRecordSchema>;

export const jobStatusEventSchema = z.object({
  type: z.literal("job-status"),
  jobType: jobTypeSchema,
  status: jobStatusSchema,
  projectName: z.string(),
  sessionName: z.string(),
  // Non-empty because the lifecycle projection uses jobId as the StatusBus
  // scopeId, which the envelope schema requires to be non-empty.
  jobId: z.string().min(1),
  branchName: z.string(),
  mergeHash: z.string().optional(),
  commitHash: z.string().optional(),
  conflictCount: z.number().optional(),
  conflictFiles: z.array(z.string()).optional(),
  errorMessage: z.string().optional(),
  phase: z.string().optional(),
  parkedRef: z.string().optional(),
  preparedSha: z.string().optional(),
  expectedTargetSha: z.string().optional(),
  refreshWarning: z.string().optional(),
  upToDate: z.boolean().optional(),
  haltReason: mergeHaltReasonSchema.optional(),
  lastProgressAt: z.string().optional(),
  intentSource: mergeIntentSourceSchema.optional(),
});
export type JobStatusEvent = z.infer<typeof jobStatusEventSchema>;

export const jobDispatchResponseSchema = z.object({
  jobId: z.string(),
  jobType: jobTypeSchema,
  branchName: z.string(),
  startedAt: z.string(),
});

export const smartMergeRequestSchema = z.object({
  autoResolve: z.boolean(),
});

export const conflictEntrySchema = z.object({
  file: z.string(),
  description: z.string(),
  resolution: z.string(),
  rationale: z.string(),
});
export type ConflictEntry = z.infer<typeof conflictEntrySchema>;

export const conflictDecisionInputSchema = z.object({
  file: z.string(),
  decision: z.enum(["approved", "rejected", "pending"]),
  feedback: z.string().optional(),
});
export type ConflictDecisionInput = z.infer<typeof conflictDecisionInputSchema>;

export const resolveConflictsRequestSchema = z.object({
  decisions: z.array(conflictDecisionInputSchema).optional(),
});

export const jobsResponseSchema = z.object({
  jobs: z.array(backgroundJobSchema),
});
export type JobsResponse = z.infer<typeof jobsResponseSchema>;
