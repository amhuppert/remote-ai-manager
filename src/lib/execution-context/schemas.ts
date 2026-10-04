import { z } from "zod";
import { seatAssignmentSchema } from "@/lib/conversation-core/schemas";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { workspaceBindingRequestSchema } from "@/lib/workspace/schemas";

// ---------------------------------------------------------------------------
// Contract: frozen at launch by Run's resolver; changed only by amendment.
// ---------------------------------------------------------------------------

export const reviewerAuthoritySchema = z.enum(["blocking", "advisory"]);
export type ReviewerAuthority = z.infer<typeof reviewerAuthoritySchema>;

export const reviewerAssignmentSchema = seatAssignmentSchema
  .extend({ authority: reviewerAuthoritySchema })
  .strict();
export type ReviewerAssignment = z.infer<typeof reviewerAssignmentSchema>;

export const contractTaskSchema = z
  .object({
    id: z.string().trim().min(1),
    title: z.string().trim().min(1),
    instructions: z.string().trim().min(1).optional(),
  })
  .strict();
export type ContractTask = z.infer<typeof contractTaskSchema>;

export const acceptanceCriterionSchema = z
  .object({ id: z.string().trim().min(1), text: z.string().trim().min(1) })
  .strict();
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

/** A frozen document snapshot, read through Artifacts by reference. */
export const contractDocumentSchema = z
  .object({
    artifactId: z.string().min(1),
    path: z.string().min(1),
    description: z.string().min(1),
    readWhen: z.string().min(1).optional(),
  })
  .strict();
export type ContractDocument = z.infer<typeof contractDocumentSchema>;

/** The accepted result of earlier work this Context builds on, bound when it starts. */
export const contractInputSchema = z
  .object({
    /** The earlier work's key in its run, telling apart works with one title. */
    key: z.string().min(1),
    /** The earlier work's title, as its owner named it. */
    title: z.string().min(1),
    output: z.unknown(),
  })
  .strict();
export type ContractInput = z.infer<typeof contractInputSchema>;

export const contextContractSchema = z
  .object({
    title: z.string().trim().min(1),
    brief: z.string().trim().min(1),
    tasks: z.array(contractTaskSchema),
    acceptanceCriteria: z.array(acceptanceCriterionSchema),
    outputSchema: z.record(z.string(), z.unknown()).nullable(),
    allowTaskAddition: z.boolean(),
    implementer: seatAssignmentSchema,
    reviewers: z.array(reviewerAssignmentSchema),
    /** Context-scoped acceptance checks; they run as readers before seats. */
    checks: z.array(validationCommandNameSchema),
    /**
     * Whole-tree checks this Context does not run because other work writes the
     * same workspace alongside it; later work runs them on the assembled tree.
     */
    deferredChecks: z.array(validationCommandNameSchema).default([]),
    inputs: z.array(contractInputSchema).default([]),
    humanApproval: z.boolean(),
    /** Whether seats may ask their owner questions. */
    ownerQuestions: z.boolean(),
    documents: z.array(contractDocumentSchema),
  })
  .strict();
export type ContextContract = z.infer<typeof contextContractSchema>;

/** Execution policy is not part of the contract, so a grant never voids a candidate. */
export const contextPolicySchema = z
  .object({
    unfinishedTaskRetries: z.number().int().min(0),
    validationRetries: z.number().int().min(0),
    captureRepairLimit: z.number().int().min(0),
    instabilityLimit: z.number().int().min(1),
    adviceCorrectionLimit: z.number().int().min(0),
    invocationTimeoutMs: z.number().int().min(0).nullable(),
  })
  .strict();
export type ContextPolicy = z.infer<typeof contextPolicySchema>;

export const DEFAULT_CONTEXT_POLICY: ContextPolicy = {
  unfinishedTaskRetries: 2,
  validationRetries: 3,
  captureRepairLimit: 1,
  instabilityLimit: 3,
  adviceCorrectionLimit: 1,
  invocationTimeoutMs: null,
};

// ---------------------------------------------------------------------------
// Facts: the only stored state. Each slice has one private owner module.
// ---------------------------------------------------------------------------

export const seatsFactsSchema = z
  .object({
    /** assignment id → conversation id, set when the seat conversation exists. */
    conversations: z.record(z.string(), z.string()),
    /** assignment id → replacement count after lost continuity. */
    replacements: z.record(z.string(), z.number().int().min(1)),
  })
  .strict();

export const taskStatusSchema = z.enum(["open", "done"]);
export const ledgerTaskSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    instructions: z.string().min(1).optional(),
    source: z.enum(["contract", "agent"]),
    status: taskStatusSchema,
  })
  .strict();
export type LedgerTask = z.infer<typeof ledgerTaskSchema>;

export const ledgerFactsSchema = z
  .object({
    revision: z.number().int().min(0),
    tasks: z.array(ledgerTaskSchema),
    /** Settled implementer work turns; the first is free, later ones are retries. */
    settledWorkTurns: z.number().int().min(0),
    /** The last work turn's final text: the result when no output schema is declared. */
    lastSummary: z.string().nullable(),
  })
  .strict();

export const candidateProvenanceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("work") }).strict(),
  z
    .object({ kind: z.literal("advice_response"), roundId: z.string().min(1) })
    .strict(),
]);
export type CandidateProvenance = z.infer<typeof candidateProvenanceSchema>;

export const candidateSchema = z
  .object({
    id: z.string().min(1),
    contractRevision: z.number().int().min(1),
    taskRevision: z.number().int().min(0),
    output: z.unknown(),
    /** Opaque Workspace evidence identity for the reviewed content. */
    evidence: z.string().min(1),
    provenance: candidateProvenanceSchema,
  })
  .strict();
export type Candidate = z.infer<typeof candidateSchema>;

export const retirementReasonSchema = z.enum([
  "reworked",
  "advised",
  "changed",
]);
export type RetirementReason = z.infer<typeof retirementReasonSchema>;

export const candidatesFactsSchema = z
  .object({
    sequence: z.number().int().min(0),
    items: z.array(candidateSchema),
    retired: z.array(
      z
        .object({ candidateId: z.string(), reason: retirementReasonSchema })
        .strict(),
    ),
    /** Output captured since the last work turn, awaiting its freeze. */
    captured: z
      .object({ output: z.unknown(), workTurn: z.number().int().min(0) })
      .strict()
      .nullable(),
    captureFailures: z
      .object({
        workTurn: z.number().int().min(0),
        count: z.number().int().min(0),
        lastIssue: z.string(),
      })
      .strict()
      .nullable(),
    /** Retirements for changed evidence since the last work turn. */
    unstableCount: z.number().int().min(0),
    /** Set after an advisory response: evidence must be compared before acceptance. */
    verifyPending: z
      .object({ roundId: z.string().min(1) })
      .strict()
      .nullable(),
    nextProvenance: candidateProvenanceSchema,
  })
  .strict();

export const findingSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().min(1),
    criterionId: z.string().min(1).optional(),
  })
  .strict();
export type Finding = z.infer<typeof findingSchema>;

export const checkResultSchema = z
  .object({
    command: validationCommandNameSchema,
    status: z.enum(["pending", "passed", "failed", "unavailable"]),
    detail: z.string().optional(),
  })
  .strict();
export type CheckResult = z.infer<typeof checkResultSchema>;

export const seatVerdictSchema = z
  .object({
    assignmentId: z.string().min(1),
    authority: reviewerAuthoritySchema,
    status: z.enum(["pending", "pass", "fail", "defect", "unavailable"]),
    findings: z.array(findingSchema),
    advisories: z.array(findingSchema),
    detail: z.string().optional(),
  })
  .strict();
export type SeatVerdict = z.infer<typeof seatVerdictSchema>;

export const roundKindSchema = z.enum(["full", "blocking"]);
export type RoundKind = z.infer<typeof roundKindSchema>;

export const reviewRoundSchema = z
  .object({
    id: z.string().min(1),
    candidateId: z.string().min(1),
    kind: roundKindSchema,
    checks: z.array(checkResultSchema),
    seats: z.array(seatVerdictSchema),
    /** A rereview disposition retires a round without deleting its evidence. */
    retired: z.boolean(),
  })
  .strict();
export type ReviewRound = z.infer<typeof reviewRoundSchema>;

export const certificationFactsSchema = z
  .object({
    sequence: z.number().int().min(0),
    rounds: z.array(reviewRoundSchema),
  })
  .strict();

export const adviceDispositionSchema = z.enum([
  "addressed",
  "declined",
  "deferred",
]);
export const adviceFactsSchema = z
  .object({
    /** Advisory id → disposition recorded by the implementer. */
    dispositions: z.record(
      z.string(),
      z
        .object({
          disposition: adviceDispositionSchema,
          reason: z.string().optional(),
        })
        .strict(),
    ),
    correctionFailures: z.number().int().min(0),
  })
  .strict();

export const approvalFactsSchema = z
  .object({
    decisions: z.array(
      z
        .object({
          candidateId: z.string().min(1),
          contractRevision: z.number().int().min(1),
          decision: z.enum(["approved", "rejected"]),
          notes: z.string().optional(),
          decidedAt: z.string().min(1),
        })
        .strict(),
    ),
    /** Rework turns delivered for rejected candidates. */
    reworked: z.array(z.string()),
  })
  .strict();

export const acceptanceFactsSchema = z
  .object({
    receipts: z.array(
      z
        .object({ candidateId: z.string().min(1), receipt: z.string().min(1) })
        .strict(),
    ),
  })
  .strict();

export const allowanceKindSchema = z.enum([
  "unfinishedTaskRetries",
  "validationRetries",
]);
export type AllowanceKind = z.infer<typeof allowanceKindSchema>;

export const allowancesFactsSchema = z
  .object({
    granted: z
      .object({
        unfinishedTaskRetries: z.number().int().min(0),
        validationRetries: z.number().int().min(0),
      })
      .strict(),
    /** One charge per work-order cause; a duplicate submission cannot charge twice. */
    charges: z.array(
      z
        .object({
          cause: z.string().min(1),
          kind: allowanceKindSchema,
          state: z.enum(["reserved", "charged"]),
        })
        .strict(),
    ),
  })
  .strict();

export const recordedHaltKindSchema = z.enum([
  "turn_failed",
  "interrupted",
  "effect_uncertain",
  "reconcile_failed",
  "workspace_refused",
]);
export type RecordedHaltKind = z.infer<typeof recordedHaltKindSchema>;

export const recordedHaltSchema = z
  .object({
    kind: recordedHaltKindSchema,
    detail: z.string(),
    seat: z.string().optional(),
  })
  .strict();
export type RecordedHalt = z.infer<typeof recordedHaltSchema>;

export const controlFactsSchema = z
  .object({
    paused: z.boolean(),
    cancelled: z.boolean(),
    halt: recordedHaltSchema.nullable(),
    steers: z.array(
      z
        .object({
          id: z.string().min(1),
          instruction: z.string().min(1),
          consumed: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export const requestsFactsSchema = z
  .object({
    open: z.array(
      z
        .object({ questionId: z.string().min(1), seat: z.string().min(1) })
        .strict(),
    ),
    answered: z.array(
      z
        .object({
          questionId: z.string().min(1),
          seat: z.string().min(1),
          question: z.string(),
          answer: z.string(),
          continued: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

/** The Context's workspace binding: requested at start, admitted by Workspace. */
export const bindingFactsSchema = z
  .object({
    request: workspaceBindingRequestSchema,
    bound: z.boolean(),
    released: z.boolean(),
  })
  .strict();

export const contextFactsSchema = z
  .object({
    contextId: z.string().min(1),
    binding: bindingFactsSchema,
    contract: z
      .object({
        revision: z.number().int().min(1),
        current: contextContractSchema,
        amendments: z.array(
          z
            .object({
              revision: z.number().int().min(2),
              reason: z.string().min(1),
              at: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    policy: contextPolicySchema,
    seats: seatsFactsSchema,
    ledger: ledgerFactsSchema,
    candidates: candidatesFactsSchema,
    certification: certificationFactsSchema,
    advice: adviceFactsSchema,
    approval: approvalFactsSchema,
    acceptance: acceptanceFactsSchema,
    allowances: allowancesFactsSchema,
    control: controlFactsSchema,
    requests: requestsFactsSchema,
    /** Numbers planned effects so a cause is never reused after a withdrawal. */
    effectSequence: z.number().int().min(0),
  })
  .strict();
export type ContextFacts = z.infer<typeof contextFactsSchema>;

// ---------------------------------------------------------------------------
// Derived progress
// ---------------------------------------------------------------------------

export const derivedHaltKindSchema = z.enum([
  "retries_exhausted",
  "output_invalid",
  "candidate_unstable",
  "plan_defect",
  "advice_invalid",
  "unavailable",
]);
export type DerivedHaltKind = z.infer<typeof derivedHaltKindSchema>;

export const haltKindSchema = z.union([
  derivedHaltKindSchema,
  recordedHaltKindSchema,
]);
export type HaltKind = z.infer<typeof haltKindSchema>;

export const obligationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("bind") }).strict(),
  z
    .object({
      kind: z.literal("work"),
      reason: z.enum([
        "initial",
        "retry",
        "steer",
        "remediate",
        "rework",
        "continue",
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("capture_output") }).strict(),
  z.object({ kind: z.literal("freeze") }).strict(),
  z.object({ kind: z.literal("certify"), roundKind: roundKindSchema }).strict(),
  z.object({ kind: z.literal("advise") }).strict(),
  z.object({ kind: z.literal("verify") }).strict(),
  z
    .object({ kind: z.literal("await_answer"), questionId: z.string().min(1) })
    .strict(),
  z
    .object({
      kind: z.literal("await_approval"),
      candidateId: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal("accept"), candidateId: z.string().min(1) })
    .strict(),
]);
export type Obligation = z.infer<typeof obligationSchema>;

const settledProgressSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("running"), obligation: obligationSchema })
    .strict(),
  z
    .object({ kind: z.literal("waiting"), obligation: obligationSchema })
    .strict(),
  z
    .object({
      kind: z.literal("halted"),
      halt: haltKindSchema,
      detail: z.string(),
    })
    .strict(),
  z.object({ kind: z.literal("stopping") }).strict(),
  z
    .object({ kind: z.literal("succeeded"), candidateId: z.string().min(1) })
    .strict(),
  z.object({ kind: z.literal("cancelled") }).strict(),
]);

/** Progress apart from pause: what the chain itself asks for next. */
export type SettledProgress = z.infer<typeof settledProgressSchema>;

export const contextProgressSchema = z.union([
  settledProgressSchema,
  z
    .object({
      kind: z.literal("paused"),
      next: settledProgressSchema.nullable(),
      draining: z.boolean(),
    })
    .strict(),
]);
export type ContextProgress = z.infer<typeof contextProgressSchema>;

/** Dispositions that clear a halt, bound to the halt's occurrence id. */
export const haltDispositionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("grant"),
      allowance: allowanceKindSchema,
      count: z.number().int().min(1),
      reason: z.string().min(1),
    })
    .strict(),
  z.object({ kind: z.literal("retry_capture") }).strict(),
  z.object({ kind: z.literal("continue") }).strict(),
  z.object({ kind: z.literal("rereview"), reason: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("retry_advice") }).strict(),
  z.object({ kind: z.literal("retry") }).strict(),
  z.object({ kind: z.literal("replace_seat") }).strict(),
  z
    .object({ kind: z.literal("confirm_effect"), evidence: z.string().min(1) })
    .strict(),
]);
export type HaltDisposition = z.infer<typeof haltDispositionSchema>;

/** One persisted Context: its facts, its frozen placement and the progress projection. */
export const contextRecordSchema = z
  .object({
    contextId: z.string().min(1),
    runId: z.string().min(1),
    projectPath: z.string().min(1),
    sessionName: z.string().min(1),
    ownerConversationId: z.string().min(1),
    startCause: z.string().min(1),
    workspace: workspaceBindingRequestSchema,
    facts: contextFactsSchema,
    revision: z.number().int().min(1),
    progress: contextProgressSchema,
    /** Changes whenever the derived progress kind changes; Run keys boundaries by it. */
    progressOccurrence: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();
export type ContextRecord = z.infer<typeof contextRecordSchema>;

/** The request a Run records to start one Context invocation. */
export const contextStartRequestSchema = z
  .object({
    contextId: z.string().min(1),
    runId: z.string().min(1),
    ownerConversationId: z.string().min(1),
    workspace: workspaceBindingRequestSchema,
    contract: contextContractSchema,
    policy: contextPolicySchema,
  })
  .strict();
export type ContextStartRequest = z.infer<typeof contextStartRequestSchema>;
