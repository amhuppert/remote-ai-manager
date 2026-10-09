import { DISPOSITIONS_BY_HALT } from "./advance";
import { adviceItemsOf } from "./advice";
import { approvalStanding } from "./approval";
import { activeRound, certificationStanding } from "./certification";
import { currentCandidate } from "./candidates";
import { openTasks } from "./ledger";
import type {
  AllowanceKind,
  ContextConfiguration,
  ContextContract,
  ContextEffectKind,
  ContextFacts,
  ContextPolicy,
  ContextHaltView,
  ContextRecord,
  ContextStage,
  ContextStartRequest,
  ContextState,
  ContextStep,
  ContextView,
  HaltDisposition,
  Obligation,
  Remedy,
  ReviewRound,
  ReviewRoundView,
  SeatSummary,
  SettledProgress,
} from "./schemas";
import type { SeatAssignment } from "@/lib/conversation-core/schemas";
import type { WorkspaceBindingRequest } from "@/lib/workspace/schemas";

/** What the view reads beyond the record: the Run's lookups, and whether an effect is admitted now. */
export type ContextViewInput = ContextViewLookups & {
  /** An admitted effect is running: a pause lets it finish. */
  active: boolean;
};

export interface ContextViewLookups {
  /** An open question's text and when its seat asked it. */
  question(questionId: string): { text: string; askedAt: string } | null;
  /**
   * When the current progress occurrence began, as the Run recorded it for its
   * owner; null when it recorded none, and the record's last change stands in.
   */
  since: string | null;
  /** The Run's pause holds the Context's next effects, though the Context itself is not paused. */
  held: boolean;
}

type StageKey = ContextStage["key"];

/** What a Context will be, before it starts. */
export type PlannedContextView = Pick<
  ContextView,
  | "title"
  | "brief"
  | "stages"
  | "tasks"
  | "taskList"
  | "criteria"
  | "implementer"
  | "reviewers"
  | "humanApproval"
  | "inputs"
  | "configuration"
>;

const STAGES: ReadonlyArray<{ key: StageKey; label: string }> = [
  { key: "workspace", label: "Workspace" },
  { key: "work", label: "Work" },
  { key: "output", label: "Result" },
  { key: "review", label: "Review" },
  { key: "approval", label: "Approval" },
  { key: "accept", label: "Accept" },
];

function seatSummary(
  role: SeatSummary["role"],
  seat: SeatAssignment & { authority?: SeatSummary["authority"] },
): SeatSummary {
  const { parameters } = seat.modelSelection;
  return {
    assignment: seat.id,
    role,
    backend: seat.backend,
    model: seat.modelSelection.modelId,
    effort: parameters.effort ?? parameters.reasoning ?? null,
    profile: seat.profile.id,
    ...(seat.authority !== undefined ? { authority: seat.authority } : {}),
    ...(seat.focus !== undefined ? { focus: seat.focus } : {}),
  };
}

/** The open round of the review the obligation asks for, or the one it will open. */
function reviewStep(
  facts: ContextFacts,
  roundKind: ReviewRound["kind"],
): ContextStep {
  const candidate = currentCandidate(facts);
  const rounds = facts.certification.rounds;
  const index = rounds.findLastIndex(
    (round) =>
      !round.retired &&
      round.kind === roundKind &&
      round.candidateId === candidate?.id,
  );
  const round = rounds[index];
  if (round === undefined) {
    const seats = facts.contract.current.reviewers.filter(
      (seat) => roundKind === "full" || seat.authority === "blocking",
    );
    return {
      kind: "review",
      round: facts.certification.sequence + 1,
      roundKind,
      reviewersDone: 0,
      reviewersTotal: seats.length,
    };
  }
  return {
    kind: "review",
    round: index + 1,
    roundKind,
    reviewersDone: round.seats.filter((seat) => seat.status !== "pending")
      .length,
    reviewersTotal: round.seats.length,
  };
}

/** The step an obligation is; waiting on a person is a state, not a step. */
function stepOf(
  facts: ContextFacts,
  obligation: Obligation,
): ContextStep | null {
  switch (obligation.kind) {
    case "bind":
      return { kind: "workspace" };
    case "work":
      return { kind: "work", reason: obligation.reason };
    case "capture_output":
    case "freeze":
      return { kind: "output" };
    case "certify":
      return reviewStep(facts, obligation.roundKind);
    case "advise":
      return { kind: "advice" };
    case "verify":
      return { kind: "verify" };
    case "accept":
      return { kind: "accept" };
    case "await_answer":
    case "await_approval":
      return null;
  }
}

const STAGE_OF_STEP: Record<ContextStep["kind"], StageKey> = {
  workspace: "workspace",
  work: "work",
  output: "output",
  review: "review",
  advice: "review",
  verify: "review",
  accept: "accept",
};

/** The obligation a progress stands at, through a pause. */
function obligationOf(progress: ContextRecord["progress"]): Obligation | null {
  const settled: SettledProgress | null =
    progress.kind === "paused" ? progress.next : progress;
  return settled !== null &&
    (settled.kind === "running" || settled.kind === "waiting")
    ? settled.obligation
    : null;
}

/**
 * The first stage the chain has not finished, read from the facts: where a
 * pause with nothing next, a stop, or a halt no effect caused leaves it.
 */
function unfinishedStage(facts: ContextFacts): StageKey {
  if (!facts.binding.bound) return "workspace";
  const candidate = currentCandidate(facts);
  if (candidate === null) {
    return facts.ledger.settledWorkTurns === 0 || openTasks(facts).length > 0
      ? "work"
      : "output";
  }
  const certification = certificationStanding(facts, candidate);
  if (certification.kind !== "cleared" && certification.kind !== "not_required")
    return "review";
  return approvalStanding(facts, candidate).kind === "pending"
    ? "approval"
    : "accept";
}

/** Where the chain stands: the stage it works on, waits in or halted at. */
function currentStage(record: ContextRecord): StageKey {
  const { facts, progress } = record;
  const obligation = obligationOf(progress);
  if (obligation !== null) {
    if (obligation.kind === "await_approval") return "approval";
    if (obligation.kind === "await_answer") {
      const asking = facts.requests.open[0]?.seat;
      return asking === facts.contract.current.implementer.id
        ? "work"
        : "review";
    }
    const step = stepOf(facts, obligation);
    if (step !== null) return STAGE_OF_STEP[step.kind];
  }
  if (progress.kind === "halted") {
    switch (progress.halt) {
      case "plan_defect":
      case "advice_invalid":
      case "unavailable":
        return "review";
      case "output_invalid":
      case "candidate_unstable":
        return "output";
      case "retries_exhausted":
        return openTasks(facts).length > 0 ? "work" : "review";
    }
    // A recorded halt names the effect that halted, where the chain stood.
    const effect = facts.control.halt?.effect;
    const stage = effect === undefined ? null : STAGE_OF_EFFECT[effect];
    if (stage !== null && stage !== undefined) return stage;
  }
  return unfinishedStage(facts);
}

/** The stage each effect belongs to; an answer wait belongs to whichever turn asked. */
const STAGE_OF_EFFECT: Record<ContextEffectKind, StageKey | null> = {
  bind: "workspace",
  work: "work",
  capture_output: "output",
  freeze: "output",
  check: "review",
  review: "review",
  advise: "review",
  verify: "review",
  accept: "accept",
  answer: null,
};

function stagesOf(record: ContextRecord, state: ContextState): ContextStage[] {
  const { facts, progress } = record;
  const contract = facts.contract.current;
  const stages = STAGES.filter(
    (stage) => stage.key !== "approval" || contract.humanApproval,
  );
  const succeeded = progress.kind === "succeeded";
  const at = succeeded
    ? stages.length
    : stages.findIndex((stage) => stage.key === currentStage(record));
  const obligation = obligationOf(progress);
  return stages.map((stage, index) => {
    if (stage.key === "review" && !reviewed(contract))
      return { ...stage, state: "skipped" };
    if (index < at) {
      const rounds = facts.certification.rounds.length;
      return stage.key === "review" && rounds > 1
        ? { ...stage, state: "done", note: `round ${rounds}` }
        : { ...stage, state: "done" };
    }
    if (index > at || progress.kind === "cancelled")
      return { ...stage, state: "pending" };
    if (progress.kind === "halted") return { ...stage, state: "halted" };
    if (state.kind === "paused")
      return { ...stage, state: "current", note: "paused" };
    if (
      obligation?.kind === "await_approval" ||
      obligation?.kind === "await_answer"
    )
      return { ...stage, state: "waiting" };
    const step = obligation === null ? null : stepOf(facts, obligation);
    if (step?.kind === "review" && step.reviewersTotal > 0)
      return {
        ...stage,
        state: "current",
        note: `${step.reviewersDone} of ${step.reviewersTotal}`,
      };
    if (step?.kind === "work" && facts.ledger.settledWorkTurns > 0)
      return {
        ...stage,
        state: "current",
        note: `turn ${facts.ledger.settledWorkTurns + 1}`,
      };
    return { ...stage, state: "current" };
  });
}

function allowanceOf(facts: ContextFacts, kind: AllowanceKind) {
  return {
    used: facts.allowances.charges.filter((charge) => charge.kind === kind)
      .length,
    limit: facts.policy[kind] + facts.allowances.granted[kind],
  };
}

function remedyOf(
  facts: ContextFacts,
  disposition: HaltDisposition["kind"],
): Remedy {
  if (disposition !== "grant") return { kind: disposition };
  // Retries run out on open tasks first; otherwise on failed blocking review.
  const allowance: AllowanceKind =
    openTasks(facts).length > 0 ? "unfinishedTaskRetries" : "validationRetries";
  return { kind: "grant", allowance, ...allowanceOf(facts, allowance) };
}

function stateOf(
  record: ContextRecord,
  since: string,
  run: { held: boolean; active: boolean },
): ContextState {
  const { facts, progress } = record;
  switch (progress.kind) {
    case "running":
    case "waiting": {
      const { obligation } = progress;
      if (obligation.kind === "await_answer")
        return { kind: "awaiting_answer" };
      if (obligation.kind === "await_approval")
        return { kind: "awaiting_approval", requestedAt: since };
      const step = stepOf(facts, obligation);
      if (step === null) return { kind: "awaiting_answer" };
      // The Run's pause holds what comes next; an admitted turn finishes first.
      return run.held
        ? { kind: "paused", next: step, draining: run.active }
        : { kind: "running", step };
    }
    case "halted": {
      const seat = facts.control.halt?.seat;
      const halt: ContextHaltView = {
        kind: progress.halt,
        detail: progress.detail,
        occurrence: record.progressOccurrence,
        at: since,
        remedies: DISPOSITIONS_BY_HALT[progress.halt].map((d) =>
          remedyOf(facts, d),
        ),
        ...(seat !== undefined ? { seat } : {}),
      };
      return { kind: "halted", halt };
    }
    case "paused": {
      const obligation = obligationOf(progress);
      return {
        kind: "paused",
        next: obligation === null ? null : stepOf(facts, obligation),
        draining: progress.draining,
      };
    }
    case "stopping":
      return { kind: "stopping" };
    case "succeeded": {
      const accepted = facts.acceptance.receipts.find(
        (receipt) => receipt.candidateId === progress.candidateId,
      );
      return { kind: "succeeded", at: accepted?.at ?? since };
    }
    case "cancelled":
      return { kind: "cancelled" };
  }
}

/**
 * Whether a round can still finish: it is the round certifying the current
 * candidate, and the Context has not stopped.
 */
function roundLive(record: ContextRecord, round: ReviewRound): boolean {
  const { facts, progress } = record;
  if (
    progress.kind === "cancelled" ||
    progress.kind === "stopping" ||
    progress.kind === "succeeded"
  )
    return false;
  const candidate = currentCandidate(facts);
  return candidate !== null && activeRound(facts, candidate)?.id === round.id;
}

/** A round's verdict: the certification standing while it is live, its recorded results once it is not. */
function roundOutcome(
  record: ContextRecord,
  round: ReviewRound,
  live: boolean,
): ReviewRoundView["outcome"] {
  if (round.retired) return "retired";
  const candidate = currentCandidate(record.facts);
  if (live && candidate !== null) {
    const standing = certificationStanding(record.facts, candidate).kind;
    if (standing === "pending") return "running";
    return standing === "cleared" || standing === "not_required"
      ? "passed"
      : "failed";
  }
  const blocking = round.seats.filter((seat) => seat.authority === "blocking");
  if (
    round.checks.some(
      (check) => check.status === "failed" || check.status === "unavailable",
    ) ||
    blocking.some(
      (seat) =>
        seat.status === "fail" ||
        seat.status === "defect" ||
        seat.status === "unavailable",
    )
  )
    return "failed";
  const open =
    round.checks.some((check) => check.status === "pending") ||
    round.seats.some((seat) => seat.status === "pending");
  // A round that can no longer finish, and never reached a verdict, was left behind.
  return open ? "retired" : "passed";
}

function roundsOf(
  record: ContextRecord,
  reviewers: ReadonlyMap<string, SeatSummary>,
): ReviewRoundView[] {
  const { facts } = record;
  return facts.certification.rounds.map((round, index) => {
    const live = roundLive(record, round);
    const outcome = roundOutcome(record, round, live);
    const advice = adviceItemsOf(round);
    return {
      number: index + 1,
      kind: round.kind,
      outcome,
      at: round.openedAt ?? null,
      checks: round.checks.map((check) => ({
        command: check.command,
        status:
          check.status === "pending"
            ? live
              ? "running"
              : "skipped"
            : check.status,
        durationMs: null,
        ...(check.detail !== undefined ? { detail: check.detail } : {}),
      })),
      seats: round.seats.map((seat) => {
        const items = advice.filter(
          (item) => item.assignmentId === seat.assignmentId,
        );
        return {
          assignment: seat.assignmentId,
          seat: reviewers.get(seat.assignmentId) ?? null,
          status: seat.status,
          findings: seat.findings,
          advisories: seat.advisories.map((advisory, ordinal) => {
            const id = items[ordinal]?.id;
            const recorded =
              id === undefined ? undefined : facts.advice.dispositions[id];
            return {
              ...advisory,
              disposition: recorded?.disposition ?? null,
              ...(recorded?.reason !== undefined && recorded.reason !== ""
                ? { dispositionNote: recorded.reason }
                : {}),
            };
          }),
        };
      }),
    };
  });
}

function outputOf(record: ContextRecord): ContextView["output"] {
  const { facts, progress } = record;
  if (facts.contract.current.outputSchema === null) return null;
  if (progress.kind === "succeeded") {
    const accepted = facts.candidates.items.find(
      (candidate) => candidate.id === progress.candidateId,
    );
    return accepted === undefined
      ? null
      : { status: "accepted", value: accepted.output };
  }
  const candidate = currentCandidate(facts);
  return candidate === null
    ? null
    : { status: "candidate", value: candidate.output };
}

/** What a Context shows a person: its facts read as the run page presents them (design §9). */
export function contextView(
  record: ContextRecord,
  lookups: ContextViewInput,
): ContextView {
  const { facts } = record;
  const contract = facts.contract.current;
  const since = lookups.since ?? record.updatedAt;
  const state = stateOf(record, since, lookups);
  const reviewers = new Map(
    contract.reviewers.map((seat) => [seat.id, seatSummary("reviewer", seat)]),
  );
  const obligation = obligationOf(record.progress);
  const tasks = facts.ledger.tasks;
  return {
    contextId: record.contextId,
    title: contract.title,
    brief: contract.brief,
    state,
    stages: stagesOf(record, state),
    tasks: {
      done: tasks.filter((task) => task.status === "done").length,
      total: tasks.length,
    },
    taskList: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      done: task.status === "done",
    })),
    criteria: contract.acceptanceCriteria,
    implementer: seatSummary("implementer", contract.implementer),
    reviewers: [...reviewers.values()],
    humanApproval: contract.humanApproval,
    startedAt: record.createdAt,
    questions: facts.requests.open.flatMap((open) => {
      const asked = lookups.question(open.questionId);
      return asked === null
        ? []
        : [
            {
              questionId: open.questionId,
              seat: open.seat,
              question: asked.text,
              askedAt: asked.askedAt,
            },
          ];
    }),
    reviews: roundsOf(record, reviewers),
    output: outputOf(record),
    inputs: contract.inputs,
    approval:
      obligation?.kind === "await_approval"
        ? { candidateId: obligation.candidateId, requestedAt: since }
        : null,
    lastSummary: facts.ledger.lastSummary,
    decisions: facts.approval.decisions.map(
      ({ contractRevision: _revision, ...decision }) => decision,
    ),
    configuration: configurationOf(contract, facts.policy, record.workspace, {
      unfinishedTaskRetries: allowanceOf(facts, "unfinishedTaskRetries"),
      validationRetries: allowanceOf(facts, "validationRetries"),
    }),
    incarnations: Object.fromEntries(
      [contract.implementer, ...contract.reviewers].map((seat) => [
        seat.id,
        facts.seats.replacements[seat.id] ?? 0,
      ]),
    ),
  };
}

/** Work a run has defined but not started, read from its start request. */
export function plannedContextView(
  request: ContextStartRequest,
): PlannedContextView {
  const { contract, policy, workspace } = request;
  const unused = (kind: AllowanceKind) => ({ used: 0, limit: policy[kind] });
  return {
    title: contract.title,
    brief: contract.brief,
    stages: STAGES.filter(
      (stage) => stage.key !== "approval" || contract.humanApproval,
    ).map((stage) => ({
      ...stage,
      state:
        stage.key === "review" && !reviewed(contract) ? "skipped" : "pending",
    })),
    tasks: { done: 0, total: contract.tasks.length },
    taskList: contract.tasks.map((task) => ({
      id: task.id,
      title: task.title,
      done: false,
    })),
    criteria: contract.acceptanceCriteria,
    implementer: seatSummary("implementer", contract.implementer),
    reviewers: contract.reviewers.map((seat) => seatSummary("reviewer", seat)),
    humanApproval: contract.humanApproval,
    inputs: contract.inputs,
    configuration: configurationOf(contract, policy, workspace, {
      unfinishedTaskRetries: unused("unfinishedTaskRetries"),
      validationRetries: unused("validationRetries"),
    }),
  };
}

function configurationOf(
  contract: ContextContract,
  policy: ContextPolicy,
  workspace: WorkspaceBindingRequest,
  allowances: Record<AllowanceKind, { used: number; limit: number }>,
): ContextConfiguration {
  return {
    checks: contract.checks,
    deferredChecks: contract.deferredChecks,
    ownerQuestions: contract.ownerQuestions,
    allowTaskAddition: contract.allowTaskAddition,
    documentPublishing: contract.documentPublishing,
    scope: workspace.scope,
    worktreePath: workspace.worktreePath,
    branch: workspace.kind === "lane" ? workspace.branch : null,
    outputSchema: contract.outputSchema,
    policy: {
      ...allowances,
      captureRepairLimit: policy.captureRepairLimit,
      instabilityLimit: policy.instabilityLimit,
      adviceCorrectionLimit: policy.adviceCorrectionLimit,
      invocationTimeoutMs: policy.invocationTimeoutMs,
    },
  };
}

/** Whether anything certifies the Context's result: checks or reviewers. */
function reviewed(contract: ContextContract): boolean {
  return contract.checks.length > 0 || contract.reviewers.length > 0;
}
