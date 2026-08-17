/**
 * How a cohort of specialists reviews one frozen candidate: they all start at
 * once, each survives its own infrastructure trouble, and what they collectively
 * decided is resolved by one precedence rule.
 *
 * Two ideas are worth stating because everything here follows from them.
 *
 * First, a verdict means "the review concluded". An infrastructure failure is
 * not a verdict, so it can neither reject work nor stand in for a reviewer that
 * never spoke; and a dispatch the global query semaphore never admitted is not
 * even an infrastructure failure — nothing ran, so nothing about the specialist
 * or its inputs was tested. Attempts therefore count admitted-and-failed
 * dispatches only, which is what keeps queue depth from consuming a retry
 * budget meant for real trouble.
 *
 * Second, an unheard REQUIRED validator makes a round unconcludable. All-of
 * semantics mean the passing siblings cannot vouch for what it would have said,
 * so a round with no rejection and an exhausted specialist does not conclude at
 * all — it stays open, uncharged, with its settled verdicts retained for a
 * resume that reruns only the lanes that never settled. "Required" is now the
 * seat's authority: only a BLOCKING lane is one the round waits to hear from,
 * and an advisory lane is by construction unable to reject work or to hold a
 * round open (R5).
 *
 * Everything here is pure or injected: {@link runCohortLanes} takes the dispatch
 * function rather than knowing how a specialist runs, and {@link concludeCohort}
 * is a total function of the settled lanes.
 */

import type { AgentBackendId } from "@/lib/shared/schemas";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import type { ValidatorAuthority } from "@/lib/workflow-graph/config-schemas";
import type {
  WorkflowValidatorAdvisory,
  WorkflowValidatorIssue,
  WorkflowValidatorPlanDefect,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowValidationSessionRef,
  GraphWorkflowValidationSpecialistState,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowContextValidationOutcome } from "./execution-validation";

/**
 * A validator's finding, carrying WHO raised it.
 *
 * The assignment is stamped by the engine at the one point that knows it — the
 * dispatch that ran the specialist — rather than inferred later from the text.
 * A reviewer writes about the work, not about itself, so two specialists can
 * word the same objection identically; without this field an aggregate of a
 * cohort's findings would read as one reviewer repeating itself, and neither
 * remediation nor evidence ingestion could attribute a finding to a specialist
 * (R5.4).
 */
export type CohortFinding = WorkflowValidatorIssue & { assignmentId: string };

/**
 * A plan defect, carrying WHO raised it — stamped for the same reason a finding
 * is, at the same point.
 *
 * Attribution matters more here than for a finding, not less: a defect names no
 * task, so the seat that raised it is the only handle anything downstream has on
 * it. Plan repair reads the assignment to judge the claim, and an aggregate of
 * two seats' defects would otherwise read as one reviewer restating itself.
 */
export type CohortPlanDefect = WorkflowValidatorPlanDefect & {
  assignmentId: string;
};

/** A lane waiting on a human answer, and the batch it is waiting on. */
export interface CohortParkedLane {
  assignmentId: string;
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
}

/**
 * Admitted dispatches per specialist per round: one initial attempt plus two
 * retries. A constant, not configuration — a cohort that could buy itself more
 * retries would turn a broken provider into an unbounded spend (D5).
 */
export const COHORT_SPECIALIST_ATTEMPTS = 3;

/**
 * How many times a lane re-queues after the semaphore refuses to admit it.
 *
 * Queue pressure costs no attempt, which on its own would let a permanently
 * saturated engine spin a lane forever. Bounding the waits makes sustained
 * pressure terminate the way an unheard specialist terminates — an unconcludable
 * round the operator can resume — rather than as a hang with no halt to read.
 */
export const COHORT_ADMISSION_WAITS = 3;

/**
 * What one dispatch of one specialist produced.
 *
 * `queue_admission_timeout` exists only here, never in the engine's outcome
 * union: it says the global query semaphore never admitted the dispatch, which
 * is a fact about the engine's load and not about the review. Nothing outside a
 * lane has any use for it, because a lane's answer to it is simply to re-queue.
 */
export type CohortDispatchOutcome =
  | CohortVerdictOutcome
  | CohortLaneQuestion
  | {
      kind: "infra_error";
      reason: "exception" | "unparseable" | "schema_mismatch";
      message: string;
      engine: AgentBackendId;
      sessionRef: null;
      reviewArtifact: null;
    }
  | {
      kind: "queue_admission_timeout";
      message: string;
      engine: AgentBackendId;
    };

/** What a lane can report that is not infrastructure noise. */
type CohortVerdictOutcome = Extract<
  GraphWorkflowContextValidationOutcome,
  { kind: "pass" | "fail" | "candidate_mismatch" | "plan_defect" }
>;

/**
 * One lane's question. Deliberately narrower than the round's `asked_user`
 * outcome, which names every waiting lane: a single dispatch knows only about
 * its own batch.
 */
export interface CohortLaneQuestion {
  kind: "asked_user";
  conversationId: string;
  questionBatchId: string;
  questions: AskQuestionItem[];
}

/**
 * How a specialist's lane ended, once it stopped retrying. A single dispatch's
 * infrastructure failure is absent by construction: a lane retries it, and only
 * exhaustion settles.
 */
export type CohortSpecialistSettlement =
  | CohortVerdictOutcome
  | CohortLaneQuestion
  | Extract<GraphWorkflowContextValidationOutcome, { kind: "infra_exhausted" }>;

export interface CohortLane {
  assignmentId: string;
  /**
   * Whether this lane's settlement can gate the round. Stamped from the roster
   * seat rather than carried by the settlement: authority is a property of WHO
   * was asked, not of what came back, and a lane that could describe its own
   * authority from its verdict would be deciding its own blocking power.
   */
  authority: ValidatorAuthority;
  /** Admitted dispatches that failed as infrastructure. Never counts waits. */
  attempts: number;
  settlement: CohortSpecialistSettlement;
}

/**
 * A lane an earlier pass of this round already accounted for.
 *
 * Authority-free by construction: it is rebuilt from the round RECORD, which
 * stores what each seat did rather than what it was allowed to decide, and the
 * roster this pass runs against is the one place that answer comes from.
 */
export type RetainedCohortLane = Omit<CohortLane, "authority">;

/** One seat of the frozen roster: who runs, and what its findings may do. */
export interface CohortRosterSeat {
  assignmentId: string;
  authority: ValidatorAuthority;
}

/**
 * A lane state change, shaped to be written straight onto the round record's
 * specialist entry. Emitted as it happens rather than at the end because the
 * attempt count has to survive a reload, and a halt publishes it.
 */
export interface CohortLaneProgress {
  assignmentId: string;
  attempts: number;
  state: GraphWorkflowValidationSpecialistState;
  summary?: string | null;
  issues?: WorkflowValidatorIssue[];
  /**
   * This lane's advisories, exactly as it reported them and in that order.
   * Unstamped: the identity is the engine's, assigned by the write that accepts
   * this progress into a round it knows the `seq` of.
   */
  advisories?: WorkflowValidatorAdvisory[];
  /**
   * This lane's plan defects, as it reported them. Written beside the issues
   * because a defect is the same kind of fact — what one seat said about this
   * candidate — and the record groups both by the seat that said it.
   */
  planDefects?: WorkflowValidatorPlanDefect[];
  questionToken?: string | null;
  /**
   * The verdict's provenance, carried alongside the state change so the write
   * that accepts a verdict can publish it in the same mutation. Present only
   * for a settled verdict — an unsettled lane has no session to point at.
   */
  verdict?: {
    pass: boolean;
    sessionRef: GraphWorkflowValidationSessionRef | null;
    reviewArtifact: GraphWorkflowValidationReviewArtifact | null;
  };
  /**
   * A dispatch that failed as infrastructure and is being retried. Reported as
   * it happens rather than inferred from a rising attempt count, so the engine
   * can file it as a non-verdict incident with the reason intact.
   */
  infraFailure?: {
    reason: "exception" | "unparseable" | "schema_mismatch";
    message: string;
    engine: AgentBackendId;
  };
}

/**
 * What a lane already spent in THIS round before the current pass started.
 *
 * The failure travels with the count because the two are one fact: a count
 * without the failure that spent it could only halt with a reason the recovery
 * invented, and the operator reading that halt would be told the wrong thing
 * about their provider.
 */
export interface CohortCarriedProgress {
  /** Admitted dispatches already spent. Never includes admission waits. */
  attempts: number;
  lastFailure: {
    reason: "exception" | "unparseable" | "schema_mismatch";
    message: string;
    engine: AgentBackendId;
  };
}

export interface RunCohortLanesInput {
  /** The roster, in configured cohort order. */
  roster: readonly CohortRosterSeat[];
  /**
   * Lanes an earlier pass of this same round already accounted for and that
   * must not run again: the verdicts a resume carries forward, and any lane
   * still parked on a question the human has not answered.
   */
  retained?: Readonly<Record<string, RetainedCohortLane>>;
  /**
   * What unsettled lanes already spent in this round, recovered from the round
   * record. Absent for a fresh round, and absent for a lane whose budget an
   * operator resumed — a resume is the one thing that hands a lane a new one.
   */
  carried?: Readonly<Record<string, CohortCarriedProgress>>;
  /** Runs one specialist once. `attempt` is 1-based, for logging and prompts. */
  dispatch(
    assignmentId: string,
    attempt: number,
  ): Promise<CohortDispatchOutcome>;
  onProgress?(update: CohortLaneProgress): void;
}

function settlementState(
  settlement: CohortSpecialistSettlement,
): GraphWorkflowValidationSpecialistState {
  switch (settlement.kind) {
    case "pass":
      return "verdict_pass";
    // A plan defect is a REVIEW outcome, and the seat that raised it refused
    // this candidate — so it records as the rejection it is rather than as an
    // infrastructure failure the round would retry. It is told apart from an
    // ordinary rejection by the defects stored beside it, not by a state of its
    // own: a lane state no existing surface could render would show an operator
    // an enum name where a verdict belongs.
    case "fail":
    case "plan_defect":
      return "verdict_fail";
    case "asked_user":
      return "parked";
    default:
      // A candidate mismatch and an infra exhaustion are both "this lane never
      // rendered a usable verdict"; neither is a review outcome.
      return "infra_failed";
  }
}

function progressForSettlement(
  assignmentId: string,
  attempts: number,
  settlement: CohortSpecialistSettlement,
): CohortLaneProgress {
  const state = settlementState(settlement);
  if (settlement.kind === "pass" || settlement.kind === "fail") {
    return {
      assignmentId,
      attempts,
      state,
      summary: settlement.summary,
      issues: settlement.issues,
      advisories: settlement.advisories ?? [],
      verdict: {
        pass: settlement.kind === "pass",
        sessionRef: settlement.sessionRef ?? null,
        reviewArtifact: settlement.reviewArtifact ?? null,
      },
    };
  }
  if (settlement.kind === "plan_defect") {
    // The defects travel with the same write that accepts the verdict, so a
    // round reloaded after a crash still says WHAT the seat refused rather than
    // only that it refused something. `pass: false` for the same reason the
    // state is `verdict_fail`: the seat did not certify this candidate.
    return {
      assignmentId,
      attempts,
      state,
      summary: settlement.summary,
      issues: settlement.issues,
      advisories: settlement.advisories ?? [],
      planDefects: settlement.planDefects,
      verdict: {
        pass: false,
        sessionRef: settlement.sessionRef ?? null,
        reviewArtifact: settlement.reviewArtifact ?? null,
      },
    };
  }
  if (settlement.kind === "asked_user") {
    return {
      assignmentId,
      attempts,
      state,
      questionToken: settlement.questionBatchId,
    };
  }
  return { assignmentId, attempts, state };
}

/**
 * Dispatch the whole cohort at once and let each lane retry on its own.
 *
 * `Promise.all` over per-assignment lanes is the entire scheduling policy: no
 * lane's start waits on a sibling's completion or verdict, and the only thing
 * that decides when a lane actually begins is the engine's existing global query
 * semaphore. Results are assembled in the order of `assignmentIds` — the
 * configured cohort order — never in completion order, so the same round yields
 * the same aggregate whatever the scheduling did (R16).
 */
export async function runCohortLanes(
  input: RunCohortLanesInput,
): Promise<CohortLane[]> {
  async function runLane(seat: CohortRosterSeat): Promise<CohortLane> {
    const { assignmentId, authority } = seat;
    const retained = input.retained?.[assignmentId];
    // Stamped from THIS pass's roster, so a carried-forward lane is judged
    // under the authority the seat holds now rather than one reconstructed
    // from a record that never stored it.
    if (retained !== undefined) return { ...retained, authority };

    const carried = input.carried?.[assignmentId];
    let attempts = carried?.attempts ?? 0;
    let waits = 0;

    // The bound belongs to the ROUND, not to the process running it. A lane
    // recovered at the bound has already had its three admitted dispatches, so
    // it settles on what the record says happened rather than buying a fourth.
    if (carried !== undefined && attempts >= COHORT_SPECIALIST_ATTEMPTS) {
      return settle(seat, attempts, {
        kind: "infra_exhausted",
        assignmentId,
        attempts,
        reason: carried.lastFailure.reason,
        message: carried.lastFailure.message,
        engine: carried.lastFailure.engine,
      });
    }

    for (;;) {
      input.onProgress?.({ assignmentId, attempts, state: "running" });
      const outcome = await input.dispatch(assignmentId, attempts + 1);

      if (outcome.kind === "queue_admission_timeout") {
        waits += 1;
        if (waits < COHORT_ADMISSION_WAITS) continue;
        return settle(seat, attempts, {
          kind: "infra_exhausted",
          assignmentId,
          attempts,
          reason: "never_admitted",
          message: outcome.message,
          engine: outcome.engine,
        });
      }

      if (outcome.kind === "infra_error") {
        attempts += 1;
        input.onProgress?.({
          assignmentId,
          attempts,
          state: "running",
          infraFailure: {
            reason: outcome.reason,
            message: outcome.message,
            engine: outcome.engine,
          },
        });
        if (attempts < COHORT_SPECIALIST_ATTEMPTS) continue;
        return settle(seat, attempts, {
          kind: "infra_exhausted",
          assignmentId,
          attempts,
          reason: outcome.reason,
          message: outcome.message,
          engine: outcome.engine,
        });
      }

      return settle(seat, attempts, outcome);
    }
  }

  function settle(
    seat: CohortRosterSeat,
    attempts: number,
    settlement: CohortSpecialistSettlement,
  ): CohortLane {
    input.onProgress?.(
      progressForSettlement(seat.assignmentId, attempts, settlement),
    );
    return {
      assignmentId: seat.assignmentId,
      authority: seat.authority,
      attempts,
      settlement,
    };
  }

  return await Promise.all(input.roster.map(runLane));
}

export type CohortConclusion =
  | {
      kind: "passed";
      summary: string;
      sessionRef: CohortRef["sessionRef"];
      reviewArtifact: CohortRef["reviewArtifact"];
      /** The lanes that rendered the verdicts, in cohort order. */
      verdicts: CohortLane[];
    }
  | {
      kind: "failed";
      summary: string;
      /** Every specialist's findings, contiguous and in cohort order. */
      issues: CohortFinding[];
      reopenTaskIds: string[];
      sessionRef: CohortRef["sessionRef"];
      reviewArtifact: CohortRef["reviewArtifact"];
      /** The lanes that rendered the verdicts, in cohort order. */
      verdicts: CohortLane[];
    }
  /**
   * A blocking seat refused the CONTRACT rather than the work: no task in this
   * context can remedy what it found.
   *
   * There is no `reopenTaskIds` field, and that absence is the design. The
   * round's issues are here as EVIDENCE of what the cohort saw; deriving a
   * reopen from them would hand an implementer the unfair turn — fix a
   * contract you have no authority over — that this conclusion exists to stop.
   */
  | {
      kind: "plan_defect";
      summary: string;
      /** Every defecting seat's defects, contiguous and in cohort order. */
      planDefects: CohortPlanDefect[];
      /** Every blocking seat's findings, evidence only, in cohort order. */
      issues: CohortFinding[];
      sessionRef: CohortRef["sessionRef"];
      reviewArtifact: CohortRef["reviewArtifact"];
      /** The lanes that rendered ordinary verdicts, in cohort order. */
      verdicts: CohortLane[];
    }
  /**
   * At least one lane is waiting on a human answer. The round does not
   * conclude: a parked lane has not reported, so nothing may be recorded for
   * the round yet. Every parked lane is named — answers are routed per lane, so
   * a conclusion that mentioned only the first would strand the rest — and
   * `settled` carries the verdicts a resume must not re-review.
   */
  | {
      kind: "parked";
      /** Non-empty by construction: this conclusion exists because a lane asked. */
      parked: [CohortParkedLane, ...CohortParkedLane[]];
      settled: CohortLane[];
    }
  | Extract<
      GraphWorkflowContextValidationOutcome,
      { kind: "candidate_mismatch" }
    >
  /**
   * No rejection, and a required specialist was never heard. The round does not
   * conclude: nothing is charged, no aggregate is published, and `settled`
   * carries the verdicts that must survive to the resume.
   */
  | {
      kind: "unconcluded";
      assignmentId: string;
      attempts: number;
      reason: CohortInfraReason;
      message: string;
      engine: AgentBackendId;
      settled: CohortLane[];
    };

type CohortInfraReason = Extract<
  GraphWorkflowContextValidationOutcome,
  { kind: "infra_exhausted" }
>["reason"];

interface CohortRef {
  sessionRef: Extract<
    GraphWorkflowContextValidationOutcome,
    { kind: "pass" }
  >["sessionRef"];
  reviewArtifact: Extract<
    GraphWorkflowContextValidationOutcome,
    { kind: "pass" }
  >["reviewArtifact"];
}

/**
 * Resolve what the cohort decided, in one precedence rule (R6), applied to the
 * lanes that hold blocking authority (R5).
 *
 * The order encodes the argument, not a preference:
 *
 *  1. a candidate mismatch means the round cannot prove what it reviewed, so
 *     nothing it collected may be recorded — not even a rejection;
 *  2. a parked specialist has not reported, so "every non-infra-failed
 *     specialist has reported" is false and no verdict can conclude yet — the
 *     round stays open around the wait rather than ending on the siblings;
 *  3. a plan defect outranks a rejection, because the two prescribe opposite
 *     reactions and only one of them can be right: reopening tasks for a
 *     sibling's issues while the contract those tasks answer to is itself
 *     defective is the loop this response exists to escape. The issues are kept
 *     as evidence of what the cohort saw, never as an instruction;
 *  4. any rejection concludes the round semantically — the infra-failed
 *     specialists simply run again next round, because remediation does not
 *     need their opinion to know the work is going back;
 *  5. no rejection plus an exhausted required specialist cannot conclude;
 *  6. otherwise every specialist passed.
 *
 * A defect also outranks an unheard specialist (rule 5): nothing a silent
 * reviewer could have said would make a defective contract satisfiable, so
 * holding the round open for it would buy an answer that cannot change the
 * outcome.
 *
 * Authority partitions rules 3, 4 and 5 and nothing else. Steps 1 and 2 are about
 * the CANDIDATE and about a human being waited on — neither becomes untrue
 * because the lane that surfaced it cannot reject work — so every lane still
 * counts there. An advisory lane contributes its verdict, its summary, and its
 * advisories, and is structurally incapable of failing the round or of holding
 * it open: with zero blocking seats the round concludes passed once its
 * advisory lanes have settled or exhausted.
 */
export function concludeCohort(lanes: readonly CohortLane[]): CohortConclusion {
  const mismatch = lanes.find(
    (lane) => lane.settlement.kind === "candidate_mismatch",
  );
  if (mismatch?.settlement.kind === "candidate_mismatch") {
    return mismatch.settlement;
  }

  const verdicts = lanes.filter(
    (lane) =>
      lane.settlement.kind === "pass" || lane.settlement.kind === "fail",
  );

  const parked: CohortParkedLane[] = [];
  for (const lane of lanes) {
    if (lane.settlement.kind !== "asked_user") continue;
    parked.push({
      assignmentId: lane.assignmentId,
      conversationId: lane.settlement.conversationId,
      questionBatchId: lane.settlement.questionBatchId,
      questions: lane.settlement.questions,
    });
  }
  const [firstParked, ...otherParked] = parked;
  if (firstParked !== undefined) {
    return {
      kind: "parked",
      parked: [firstParked, ...otherParked],
      settled: verdicts,
    };
  }

  // The partition. Everything below decides the round from these lanes only;
  // the advisory ones stay in `verdicts` because their reviews are still
  // reported, priced, and (for their advisories) delivered.
  const blocking = lanes.filter((lane) => lane.authority === "blocking");
  const blockingVerdicts = verdicts.filter(
    (lane) => lane.authority === "blocking",
  );
  const defected = blocking.filter(
    (lane) => lane.settlement.kind === "plan_defect",
  );

  if (defected.length > 0) {
    const planDefects: CohortPlanDefect[] = [];
    const evidence: CohortFinding[] = [];
    // Grouped by assignment exactly as findings are: contiguous, in cohort
    // order, each carrying the seat that raised it. A defect names no task, so
    // its seat is the only handle plan repair has on where it came from.
    for (const lane of blocking) {
      if (lane.settlement.kind === "plan_defect") {
        planDefects.push(...lane.settlement.planDefects);
      }
      if (
        lane.settlement.kind === "plan_defect" ||
        lane.settlement.kind === "fail"
      ) {
        // A rejection's findings ride along with the defect rather than
        // deciding the round: they say what the cohort saw, and while the
        // contract stands accused nothing may turn them into a reopen.
        evidence.push(...lane.settlement.issues);
      }
    }
    const last = lastRef(defected, "plan_defect");
    return {
      kind: "plan_defect",
      // Every lane that reported, defecting ones included: a reader of the
      // halt needs the whole round's reading of the candidate, not only the
      // seats that rendered an ordinary verdict.
      summary: joinSummaries(lanes),
      planDefects,
      issues: evidence,
      sessionRef: last.sessionRef,
      reviewArtifact: last.reviewArtifact,
      verdicts,
    };
  }

  const rejected = blockingVerdicts.some(
    (lane) => lane.settlement.kind === "fail",
  );

  if (rejected) {
    const issues: CohortFinding[] = [];
    const reopenTaskIds: string[] = [];
    const seenTaskIds = new Set<string>();
    for (const lane of blockingVerdicts) {
      if (lane.settlement.kind !== "fail") continue;
      // Findings are concatenated, never merged: two reviewers objecting to one
      // task for different reasons is two findings, and collapsing them would
      // silently discard one specialist's review. They stay grouped by
      // assignment — contiguous, in cohort order, each carrying the assignment
      // that raised it (R5.4). Only the reopen list is a set, because reopening
      // a task twice is not two reopens (R5.5).
      issues.push(...lane.settlement.issues);
      for (const taskId of lane.settlement.reopenTaskIds) {
        if (seenTaskIds.has(taskId)) continue;
        seenTaskIds.add(taskId);
        reopenTaskIds.push(taskId);
      }
    }
    // The refs come from the rejection that concluded the round, so they are
    // read off the blocking lanes even though the aggregate reports them all.
    const last = lastRef(blockingVerdicts, "fail");
    return {
      kind: "failed",
      summary: joinSummaries(verdicts),
      issues,
      reopenTaskIds,
      sessionRef: last.sessionRef,
      reviewArtifact: last.reviewArtifact,
      verdicts,
    };
  }

  // An advisory lane's exhaustion is recorded on its own lane and goes no
  // further: nothing was waiting to hear from it, so the round is not held
  // open for a review that could not have gated it.
  const exhausted = blocking.find(
    (lane) => lane.settlement.kind === "infra_exhausted",
  );
  if (exhausted?.settlement.kind === "infra_exhausted") {
    return {
      kind: "unconcluded",
      assignmentId: exhausted.assignmentId,
      attempts: exhausted.settlement.attempts,
      reason: exhausted.settlement.reason,
      message: exhausted.settlement.message,
      engine: exhausted.settlement.engine,
      settled: verdicts,
    };
  }

  const last = lastRef(verdicts, "pass");
  return {
    kind: "passed",
    summary: joinSummaries(verdicts),
    sessionRef: last.sessionRef,
    reviewArtifact: last.reviewArtifact,
    verdicts,
  };
}

/** Every reported summary, in cohort order. */
function joinSummaries(lanes: readonly CohortLane[]): string {
  return lanes
    .map((lane) =>
      lane.settlement.kind === "pass" ||
      lane.settlement.kind === "fail" ||
      lane.settlement.kind === "plan_defect"
        ? lane.settlement.summary
        : "",
    )
    .filter((summary) => summary.length > 0)
    .join("\n");
}

/**
 * The surviving session and artifact refs. The outcome carries a single pair, so
 * the last matching specialist's wins — the pre-cohort convention, kept so a
 * seeded single reviewer produces byte-identical refs.
 */
function lastRef(
  lanes: readonly CohortLane[],
  kind: "pass" | "fail" | "plan_defect",
): CohortRef {
  for (let index = lanes.length - 1; index >= 0; index -= 1) {
    const settlement = lanes[index]!.settlement;
    if (settlement.kind !== kind) continue;
    return {
      sessionRef: settlement.sessionRef ?? null,
      reviewArtifact: settlement.reviewArtifact ?? null,
    };
  }
  return { sessionRef: null, reviewArtifact: null };
}
