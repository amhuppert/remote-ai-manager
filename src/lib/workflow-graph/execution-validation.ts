import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import type {
  GraphWorkflowExecution,
  GraphWorkflowValidationCandidate,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidationSessionRef,
} from "@/lib/workflow-graph/schemas";
import {
  selectRunnableCohortAssignments,
  type SeededValidatorAssignment,
} from "@/lib/workflow-graph/config-schemas";
import type {
  GraphWorkflowResolvedContext,
  WorkflowValidatorAdvisory,
  WorkflowValidatorIssue,
} from "@/lib/workflow-graph/definition-schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  concludeCohort,
  runCohortLanes,
  type CohortCarriedProgress,
  type CohortConclusion,
  type CohortDispatchOutcome,
  type CohortFinding,
  type CohortLane,
  type CohortLaneProgress,
  type CohortParkedLane,
  type RetainedCohortLane,
} from "./validation-cohort";
import type { ValidatorOutcome, ValidatorRunResult } from "./validator-runner";
import type { ExecutionTarget } from "./execution-target-resolver";
import type { ResumeUserInputContext } from "./user-input-gate";
import { parseLaneStateKey } from "./lane-identity";

export interface GraphWorkflowContextValidatorInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowResolvedContext;
  // Seeded, not authored: the runner fingerprints the delivered profile bytes
  // to decide whether this assignment's lane can be resumed.
  validator: SeededValidatorAssignment;
  /**
   * When supplied, the validator runs against this resolved target's
   * worktree instead of the session worktree resolved by
   * `deps.resolveWorktreePath`. Solo-eligible contexts leave this undefined,
   * preserving the pre-parallelization behavior.
   */
  executionTarget?: ExecutionTarget;
  /**
   * When set, this validator run is a resume after the asking validator's
   * question was answered. The runner pins the asking conversation (rotation
   * still outranks) and embeds the answers block in the validation prompt so
   * the re-run validator sees the answers before rendering its verdict (5.1,
   * 5.3, 5.5).
   */
  resumeUserInput?: ResumeUserInputContext;
  /**
   * The round's shared inputs, rendered once before any specialist ran. When
   * supplied the runner uses these bytes verbatim instead of deriving its own,
   * which is what makes the cohort's common inputs byte-identical rather than
   * merely equivalent. Absent for a standalone run outside a round.
   */
  roundCommonSections?: ValidationRoundCommonSections;
  /**
   * The round this dispatch belongs to. The runner echoes it back on the
   * result, which is what lets a result be attributed to a round mechanically
   * rather than by re-observing the worktree and hoping it moved.
   */
  roundToken?: ValidationRoundToken;
}

/**
 * Which round a dispatch — and the result that comes back from it — belongs to.
 *
 * `seq` is the part a worktree re-probe cannot supply: two rounds of the same
 * context can freeze byte-identical candidates, so without the sequence a
 * verdict from the earlier one is indistinguishable from a current one.
 */
export interface ValidationRoundToken {
  seq: number;
  candidate: GraphWorkflowValidationCandidate;
}

/** Whether a returned token is the one the round handed out. */
export function validationRoundTokenMatches(
  expected: ValidationRoundToken,
  returned: ValidationRoundToken | null | undefined,
): boolean {
  return (
    returned !== null &&
    returned !== undefined &&
    returned.seq === expected.seq &&
    returned.candidate.headSha === expected.candidate.headSha &&
    returned.candidate.candidateTreeHash ===
      expected.candidate.candidateTreeHash &&
    returned.candidate.taskStateHash === expected.candidate.taskStateHash
  );
}

/**
 * The round as the validation service needs it: its identity token plus the
 * frozen roster already resolved back to runnable assignments, in roster order.
 *
 * The assignments are supplied rather than re-selected here on purpose. Whoever
 * froze the roster is the only party that can tell whether the definition still
 * describes the cohort that owns the candidate; re-selecting inside this module
 * would make the persisted roster a bystander and let a live config edit swap
 * the reviewers out from under an open round.
 */
export interface ValidationRoundDispatch extends ValidationRoundToken {
  assignments: readonly SeededValidatorAssignment[];
  /**
   * Lanes an earlier pass of THIS round already accounted for, keyed by
   * assignment id: the verdicts it collected, and any lane still holding a
   * standing question. A resume reruns only the rest — without these it would
   * re-review work its cohort had already judged, or re-ask a lane whose
   * question the human has not answered yet.
   */
  retained?: Readonly<Record<string, RetainedCohortLane>>;
  /**
   * What each UNSETTLED lane already spent in this round. A round outlives the
   * process running it, so a pass that started every lane at zero would reset
   * the fixed attempt bound on every restart.
   */
  carried?: Readonly<Record<string, CohortCarriedProgress>>;
}

/**
 * The parts of a validation prompt that belong to the ROUND rather than to any
 * one specialist.
 *
 * Only the diff scope lives here today: every other common section (charter,
 * invariants, acceptance criteria, task state) is derived from the frozen
 * execution state and is therefore already identical across the cohort, while
 * the diff scope is computed by probing the worktree and would otherwise be
 * re-probed per specialist — the one common input that could legitimately
 * differ between two members of the same round.
 */
export interface ValidationRoundCommonSections {
  diffScopeSection: string;
  /**
   * The identity of the tree `diffScopeSection` was rendered from, or null when
   * it could not be read. The round compares this against its frozen candidate:
   * the freeze claims "this tree is what the cohort reviews", and these are the
   * bytes the cohort actually reads, so nothing but their agreement makes the
   * claim true.
   */
  candidateTreeHash: string | null;
}

export interface RenderRoundCommonSectionsInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  context: GraphWorkflowResolvedContext;
  executionTarget?: ExecutionTarget;
}

export interface GraphWorkflowContextValidationInput {
  projectPath: string;
  sessionName: string;
  execution: GraphWorkflowExecution;
  contextId: string;
  /**
   * Resolved per-context execution target. Forwarded to the validator runner
   * so context validation in a parallel batch runs against the per-context
   * worktree, matching where the implementer turn ran.
   */
  executionTarget?: ExecutionTarget;
  /**
   * Set on a validator resume so the runner pins each asking conversation and
   * delivers the answers block into the re-run validator's prompt (5.1, 5.3).
   *
   * A LIST because several validators can be answered at once: each entry names
   * the lane that asked, and a lane receives only its own entry. Handing one
   * lane's answers to a sibling would put words in the human's mouth about a
   * question that sibling never asked.
   */
  resumeUserInputs?: readonly ResumeUserInputContext[];
  /**
   * Re-checks that the round's frozen candidate is still the candidate, called
   * after a specialist returns and BEFORE its outcome is accepted. Resolving
   * false rejects that result as an incident — it is a verdict on work that no
   * longer exists, so recording it would attribute a judgement to a tree nobody
   * reviewed. Absent outside a round, where every result is accepted.
   */
  verifyCandidate?(): Promise<boolean>;
  /**
   * The open round: its identity token and the frozen roster to dispatch. When
   * present it is the sole source of WHO reviews and of which round a result
   * belongs to. Null outside a round.
   */
  round?: ValidationRoundDispatch;
  /**
   * Called as each specialist lane starts a dispatch and as it settles, so the
   * round record's attempt counters and per-specialist states are durable while
   * the round is still running rather than only once it ends.
   */
  onSpecialistProgress?(update: CohortLaneProgress): void;
}

/**
 * What ONE cohort member decided, as the engine needs it to publish.
 *
 * Verdict-side only: profile identity comes from the round's FROZEN roster, not
 * from here, because the roster is what says which bytes the reviewer actually
 * received. Joining the two at the publication site keeps this union free of
 * provenance it would have to keep in step with the roster.
 */
export interface CohortSpecialistVerdict {
  assignmentId: string;
  pass: boolean;
  summary: string;
  issues: CohortFinding[];
  sessionRef: GraphWorkflowValidationSessionRef | null;
  reviewArtifact: GraphWorkflowValidationReviewArtifact | null;
}

/**
 * A lane's own advisories, carried on its settlement.
 *
 * Present on ONE LANE's outcome and absent from the round's aggregate: an
 * advisory belongs to the specialist that raised it, and an aggregate that
 * flattened the cohort's advisories into one list would lose the attribution the
 * engine stamps its identity from.
 */
type LaneAdvisories = { advisories?: WorkflowValidatorAdvisory[] };

export type GraphWorkflowContextValidationOutcome =
  | ({
      kind: "pass";
      summary: string;
      feedback: string;
      issues: CohortFinding[];
      reopenTaskIds: string[];
      sessionRef?: GraphWorkflowValidationSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
      /** Each member's own verdict, in cohort order. */
      specialists?: CohortSpecialistVerdict[];
    } & LaneAdvisories)
  | ({
      kind: "fail";
      summary: string;
      feedback: string;
      issues: CohortFinding[];
      reopenTaskIds: string[];
      sessionRef?: GraphWorkflowValidationSessionRef | null;
      reviewArtifact?: GraphWorkflowValidationReviewArtifact | null;
      /** Each member's own verdict, in cohort order. */
      specialists?: CohortSpecialistVerdict[];
    } & LaneAdvisories)
  // One specialist spent every admitted attempt on infrastructure failures. Not
  // a verdict: the round it belongs to cannot conclude on it, so the engine
  // halts resumably with the settled verdicts retained rather than publishing an
  // aggregate nobody rendered (R6).
  | {
      kind: "infra_exhausted";
      assignmentId: string;
      attempts: number;
      reason:
        | "exception"
        | "unparseable"
        | "schema_mismatch"
        | "never_admitted";
      message: string;
      engine: AgentBackendId;
    }
  // At least one validator asked the user a question and rendered no verdict.
  // Mapped by the orchestrator to the awaiting-user-input park path, never to
  // the validation-failure accounting (Req 3.2, 3.3).
  //
  // `parked` names EVERY waiting lane, in cohort order, and is non-empty by
  // construction: questions are per-lane, so an outcome that named only one
  // would strand the others with questions nobody could answer.
  | {
      kind: "asked_user";
      parked: [CohortParkedLane, ...CohortParkedLane[]];
    }
  // The round could not be certified against the candidate it froze. Not a
  // verdict and not an infra_error either: nothing here says the work is wrong,
  // only that this round cannot vouch for what it reviewed. The orchestrator
  // files it as an incident and concludes without charging (R5.1, R5.5).
  //
  // `diff_render` fires before any specialist is spent — the shared diff came
  // from a tree other than the frozen candidate, or could not be read at all.
  // `specialist_result` fires after one returns, from the token or the re-probe.
  | {
      kind: "candidate_mismatch";
      stage: "diff_render" | "specialist_result";
      assignmentId: string | null;
      /**
       * Which check refused the result. `stale_round_token` means nothing
       * moved — the answer simply belongs to a round that is over — while
       * `candidate_moved` means the tree changed under a live round. Only the
       * incident vocabulary distinguishes them; the round's fate is the same.
       */
      reason?: "stale_round_token" | "candidate_moved";
      /**
       * The tree the shared inputs were rendered from, on a `diff_render`
       * mismatch. Carried because it is unrecoverable afterwards: by the time
       * the engine files the incident the render is over, and a fresh worktree
       * probe would show the frozen tree intact and report nothing drifted.
       */
      observedTreeHash?: string | null;
    };

export interface GraphWorkflowValidationServiceDeps {
  runContextValidator(
    input: GraphWorkflowContextValidatorInput,
  ): Promise<ValidatorRunResult>;
  /**
   * Renders the round's shared prompt inputs once, before the first specialist
   * runs. Absent leaves each validator to derive its own, which is the correct
   * behaviour for a cohort of one and the pre-round behaviour for everyone else.
   */
  renderRoundCommonSections?(
    input: RenderRoundCommonSectionsInput,
  ): Promise<ValidationRoundCommonSections>;
}

function getContextDefinition(
  execution: GraphWorkflowExecution,
  contextId: string,
): GraphWorkflowResolvedContext {
  const context = execution.workingDefinition.executionContexts.find(
    (entry) => entry.id === contextId,
  );
  if (!context) {
    throw new Error(`Execution context "${contextId}" was not found`);
  }

  return context;
}

function formatFeedback(
  prefix: string,
  summary: string,
  issues: WorkflowValidatorIssue[],
  reopenTaskIds: string[],
): string {
  return [
    prefix,
    summary,
    ...(reopenTaskIds.length > 0
      ? ["Reopened tasks:", ...reopenTaskIds.map((taskId) => `- ${taskId}`)]
      : []),
    ...issues.map((issue) => `- ${issue.title}: ${issue.description}`),
  ].join("\n");
}

/**
 * The verdict lanes as publishable entries, in the cohort order the conclusion
 * assembled them in. Non-verdict lanes are absent by construction — the
 * conclusion only ever collects lanes that actually reported.
 */
function toSpecialistVerdicts(
  lanes: readonly CohortLane[],
): CohortSpecialistVerdict[] {
  const verdicts: CohortSpecialistVerdict[] = [];
  for (const lane of lanes) {
    const settlement = lane.settlement;
    if (settlement.kind !== "pass" && settlement.kind !== "fail") continue;
    verdicts.push({
      assignmentId: lane.assignmentId,
      pass: settlement.kind === "pass",
      summary: settlement.summary,
      issues: settlement.issues,
      sessionRef: settlement.sessionRef ?? null,
      reviewArtifact: settlement.reviewArtifact ?? null,
    });
  }
  return verdicts;
}

function mapRunnerOutcomeToContextOutcome(
  outcome: ValidatorOutcome,
  metadata: ValidatorRunResult["metadata"],
  assignmentId: string,
  cohortSize: number,
): CohortDispatchOutcome {
  if (outcome.kind === "pass") {
    const summary = attributeSummary(outcome.summary, assignmentId, cohortSize);
    return {
      kind: "pass",
      summary,
      feedback: formatFeedback("Context validation passed.", summary, [], []),
      issues: [],
      advisories: outcome.advisories,
      reopenTaskIds: [],
      sessionRef: metadata.sessionRef,
      reviewArtifact: metadata.reviewArtifact,
    };
  }

  if (outcome.kind === "fail") {
    const summary = attributeSummary(outcome.summary, assignmentId, cohortSize);
    // Stamped HERE, at the only point that knows which assignment produced the
    // finding. A validator writes about the work, not about itself, so nothing
    // in a finding's own text identifies its author (R5.4).
    const issues: CohortFinding[] = outcome.issues.map((issue) => ({
      ...issue,
      assignmentId,
    }));
    return {
      kind: "fail",
      summary,
      feedback: formatFeedback(
        "Context validation blocked completion.",
        summary,
        issues,
        outcome.reopenTaskIds,
      ),
      issues,
      advisories: outcome.advisories,
      reopenTaskIds: outcome.reopenTaskIds,
      sessionRef: metadata.sessionRef,
      reviewArtifact: metadata.reviewArtifact,
    };
  }

  if (outcome.kind === "asked_user") {
    return {
      kind: "asked_user",
      conversationId: outcome.conversationId,
      questionBatchId: outcome.questionBatchId,
      questions: outcome.questions,
    };
  }

  if (outcome.kind === "queue_admission_timeout") {
    return {
      kind: "queue_admission_timeout",
      message: outcome.message,
      engine: outcome.engine,
    };
  }

  return {
    kind: "infra_error",
    reason: outcome.reason,
    message: outcome.message,
    engine: outcome.engine,
    sessionRef: null,
    reviewArtifact: null,
  };
}

/**
 * Names the specialist in its own summary line, so a reader of an aggregate of
 * several summaries can tell whose is whose. A cohort of one keeps today's bare
 * summary verbatim — the seeded single-reviewer default reads exactly as it did
 * before cohorts existed. Structured attribution (`CohortFinding.assignmentId`)
 * is unconditional and does not depend on this.
 */
/**
 * The answers this assignment may see, if any.
 *
 * Routing is by lane key, which is where the identity of the asker lives: a
 * resume entry was consumed from the parked record of exactly one lane, so the
 * assignment it names is the only one that may be handed it. Everything else
 * runs without answers — including a lane whose own question is still parked.
 */
function resolveAssignmentResume(
  input: GraphWorkflowContextValidationInput,
  assignmentId: string,
): ResumeUserInputContext | undefined {
  return input.resumeUserInputs?.find(
    (resume) =>
      parseLaneStateKey(resume.laneKey)?.assignmentId === assignmentId,
  );
}

function attributeSummary(
  summary: string,
  assignmentId: string,
  cohortSize: number,
): string {
  return cohortSize <= 1 ? summary : `${assignmentId}: ${summary}`;
}

const defaultDeps: GraphWorkflowValidationServiceDeps = {
  async runContextValidator(): Promise<ValidatorRunResult> {
    throw new Error("Context validator runner is not configured");
  },
};

const validationLogger = createLogger("graph-workflow-validation");

export function createGraphWorkflowValidationService(
  deps: Partial<GraphWorkflowValidationServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  async function validateContextCompletion(
    input: GraphWorkflowContextValidationInput,
  ): Promise<GraphWorkflowContextValidationOutcome> {
    const context = getContextDefinition(input.execution, input.contextId);
    const cohort = context.contextValidator;
    // Inside a round the frozen roster IS the cohort. Outside one (no round has
    // been opened for this context) the definition is the only source there is.
    const assignments =
      input.round?.assignments ?? selectRunnableCohortAssignments(cohort);
    const execLogger = getExecutionLogger(input.execution.id);

    if (assignments.length === 0) {
      execLogger?.validation(input.contextId, "context_validation.skipped", {
        reason: "not_enabled",
      });
      return {
        kind: "pass",
        summary: "Context validation is not enabled",
        feedback: "Context validation is not enabled.",
        issues: [],
        reopenTaskIds: [],
      };
    }

    // Rendered ONCE for the whole round, before the first specialist runs, so
    // every member of the cohort judges byte-identical common inputs. Deriving
    // them per specialist would re-probe the worktree and could hand two
    // members of one round two different pictures of the same candidate.
    const roundCommonSections = await resolvedDeps.renderRoundCommonSections?.({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      context,
      executionTarget: input.executionTarget,
    });

    // The rendered diff is what the cohort actually reads. If it did not come
    // from the frozen tree — it moved, or it could not be read at all — the
    // round cannot certify that tree no matter what verdicts come back, so it
    // ends here rather than spending a single specialist on it.
    if (
      input.round &&
      roundCommonSections &&
      roundCommonSections.candidateTreeHash !==
        input.round.candidate.candidateTreeHash
    ) {
      execLogger?.validation(input.contextId, "context_validation.stale", {
        stage: "diff_render",
        roundSeq: input.round.seq,
        frozenTreeHash: input.round.candidate.candidateTreeHash,
        renderedTreeHash: roundCommonSections.candidateTreeHash,
      });
      validationLogger.warn("graph-workflow.context_validation.stale_inputs", {
        executionId: input.execution.id,
        contextId: input.contextId,
        roundSeq: input.round.seq,
      });
      return {
        kind: "candidate_mismatch",
        stage: "diff_render",
        assignmentId: null,
        observedTreeHash: roundCommonSections.candidateTreeHash,
      };
    }

    // Every specialist starts at once. No lane's start waits on a sibling's
    // completion or verdict; what actually decides when each begins is the
    // engine's existing global query semaphore, and the cohort adds no throttle
    // of its own (R16). Each lane retries its own infrastructure trouble against
    // the unchanged frozen candidate while its siblings' verdicts stand.
    const byId = new Map(
      assignments.map((assignment) => [assignment.id, assignment]),
    );
    const lanes = await runCohortLanes({
      roster: assignments.map((assignment) => ({
        assignmentId: assignment.id,
        authority: assignment.authority,
      })),
      ...(input.round?.retained ? { retained: input.round.retained } : {}),
      ...(input.round?.carried ? { carried: input.round.carried } : {}),
      ...(input.onSpecialistProgress
        ? { onProgress: input.onSpecialistProgress }
        : {}),
      dispatch: async (assignmentId, attempt) => {
        const validator = byId.get(assignmentId);
        if (validator === undefined) {
          throw new Error(
            `Validator assignment "${assignmentId}" is not in this round's roster`,
          );
        }
        return await runOneAssignment({
          input,
          context,
          validator,
          cohortSize: assignments.length,
          execLogger,
          roundCommonSections,
          attempt,
        });
      },
    });

    return conclusionToOutcome(concludeCohort(lanes));
  }

  /**
   * The cohort's conclusion as the engine's outcome union. A pure re-shaping —
   * the precedence that decided it lives in `concludeCohort`, so there is one
   * place to read the rule and one place to change it.
   */
  function conclusionToOutcome(
    conclusion: CohortConclusion,
  ): GraphWorkflowContextValidationOutcome {
    if (conclusion.kind === "passed") {
      return {
        kind: "pass",
        summary: conclusion.summary,
        feedback: formatFeedback(
          "Context validation passed.",
          conclusion.summary,
          [],
          [],
        ),
        issues: [],
        reopenTaskIds: [],
        sessionRef: conclusion.sessionRef ?? null,
        reviewArtifact: conclusion.reviewArtifact ?? null,
        specialists: toSpecialistVerdicts(conclusion.verdicts),
      };
    }

    if (conclusion.kind === "failed") {
      return {
        kind: "fail",
        summary: conclusion.summary,
        feedback: formatFeedback(
          "Context validation blocked completion.",
          conclusion.summary,
          conclusion.issues,
          conclusion.reopenTaskIds,
        ),
        issues: conclusion.issues,
        reopenTaskIds: conclusion.reopenTaskIds,
        sessionRef: conclusion.sessionRef ?? null,
        reviewArtifact: conclusion.reviewArtifact ?? null,
        specialists: toSpecialistVerdicts(conclusion.verdicts),
      };
    }

    if (conclusion.kind === "unconcluded") {
      return {
        kind: "infra_exhausted",
        assignmentId: conclusion.assignmentId,
        attempts: conclusion.attempts,
        reason: conclusion.reason,
        message: conclusion.message,
        engine: conclusion.engine,
      };
    }

    if (conclusion.kind === "parked") {
      // Every asking lane is named: the engine parks them all, because a lane's
      // question is its own and only the lane that asked may receive its answer.
      return { kind: "asked_user", parked: conclusion.parked };
    }

    return conclusion;
  }

  async function runOneAssignment(params: {
    input: GraphWorkflowContextValidationInput;
    context: GraphWorkflowResolvedContext;
    validator: SeededValidatorAssignment;
    cohortSize: number;
    execLogger: ReturnType<typeof getExecutionLogger>;
    roundCommonSections?: ValidationRoundCommonSections;
    /** 1-based dispatch number for this specialist within the round. */
    attempt: number;
  }): Promise<CohortDispatchOutcome> {
    const {
      input,
      context,
      validator,
      cohortSize,
      execLogger,
      roundCommonSections,
      attempt,
    } = params;

    execLogger?.validation(input.contextId, "context_validation.started", {
      assignmentId: validator.id,
      strategy: validator.strategy,
      cohortSize,
      attempt,
      acceptanceCriteriaPreview: context.acceptanceCriteria.slice(0, 200),
    });
    validationLogger.info("graph-workflow.context_validation.started", {
      executionId: input.execution.id,
      contextId: input.contextId,
      assignmentId: validator.id,
      strategy: validator.strategy,
      cohortSize,
      attempt,
    });

    const roundToken: ValidationRoundToken | undefined = input.round
      ? { seq: input.round.seq, candidate: input.round.candidate }
      : undefined;

    const resumeUserInput = resolveAssignmentResume(input, validator.id);

    const runResult = await resolvedDeps.runContextValidator({
      projectPath: input.projectPath,
      sessionName: input.sessionName,
      execution: input.execution,
      context,
      validator,
      executionTarget: input.executionTarget,
      ...(resumeUserInput ? { resumeUserInput } : {}),
      ...(roundCommonSections ? { roundCommonSections } : {}),
      ...(roundToken ? { roundToken } : {}),
    });

    // Two independent staleness checks, both BEFORE the outcome is mapped,
    // logged, or returned: a result for a moved candidate must leave no trace at
    // all, so there is nothing here for a later reader to mistake for a verdict.
    //
    // The token catches what the worktree cannot: a result belonging to an
    // EARLIER round of the same context, whose candidate may be byte-identical
    // to this one. The re-probe catches what the token cannot: a candidate that
    // moved while this very specialist was running.
    const staleReason =
      roundToken &&
      !validationRoundTokenMatches(roundToken, runResult.roundToken)
        ? "stale_round_token"
        : input.verifyCandidate && !(await input.verifyCandidate())
          ? "candidate_moved"
          : null;

    if (staleReason !== null) {
      execLogger?.validation(input.contextId, "context_validation.stale", {
        assignmentId: validator.id,
        stage: "specialist_result",
        reason: staleReason,
        ...(roundToken ? { roundSeq: roundToken.seq } : {}),
      });
      validationLogger.warn("graph-workflow.context_validation.stale_result", {
        executionId: input.execution.id,
        contextId: input.contextId,
        assignmentId: validator.id,
        reason: staleReason,
      });
      return {
        kind: "candidate_mismatch",
        stage: "specialist_result",
        assignmentId: validator.id,
        reason: staleReason,
      };
    }

    const outcome = mapRunnerOutcomeToContextOutcome(
      runResult.result,
      runResult.metadata,
      validator.id,
      cohortSize,
    );

    if (outcome.kind === "infra_error") {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        assignmentId: validator.id,
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
        message: outcome.message,
      });
      validationLogger.warn("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        assignmentId: validator.id,
        kind: outcome.kind,
        reason: outcome.reason,
        engine: outcome.engine,
      });
      validationLogger.warn("graph-workflow.context_validation.infra_error", {
        executionId: input.execution.id,
        contextId: input.contextId,
        assignmentId: validator.id,
        reason: outcome.reason,
        engine: outcome.engine,
      });
    } else if (outcome.kind === "asked_user") {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        assignmentId: validator.id,
        kind: outcome.kind,
        questionBatchId: outcome.questionBatchId,
        questionCount: outcome.questions.length,
      });
      validationLogger.info("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        assignmentId: validator.id,
        kind: outcome.kind,
        questionBatchId: outcome.questionBatchId,
      });
    } else if (outcome.kind === "pass" || outcome.kind === "fail") {
      execLogger?.validation(input.contextId, "context_validation.completed", {
        assignmentId: validator.id,
        kind: outcome.kind,
        summary: outcome.summary,
        issueCount: outcome.issues.length,
        reopenTaskIds: outcome.reopenTaskIds,
      });
      validationLogger.info("graph-workflow.context_validation.completed", {
        executionId: input.execution.id,
        contextId: input.contextId,
        assignmentId: validator.id,
        kind: outcome.kind,
        reopenTaskIds: outcome.reopenTaskIds,
      });
    }

    return outcome;
  }

  return {
    validateContextCompletion,
  };
}

export type GraphWorkflowValidationService = ReturnType<
  typeof createGraphWorkflowValidationService
>;
