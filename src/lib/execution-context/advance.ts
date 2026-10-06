import { recordAdviceResponse } from "./advice";
import {
  chargeAllowance,
  grantAllowance,
  releaseAllowance,
} from "./allowances";
import { recordDecision } from "./approval";
import { currentCandidate, freezeCandidate, retireCurrent, startWorkEpoch } from "./candidates";
import {
  activeRound,
  parseReviewVerdict,
  recordCheckResult,
  recordSeatVerdict,
  retireRound,
} from "./certification";
import type { ContextEffectRequest } from "./effects";
import { nextProgress } from "./progress";
import {
  conversationReportSchema,
  requestsReportSchema,
  workspaceReportSchema,
  type ConversationReport,
} from "./reports";
import type {
  ContextContract,
  ContextFacts,
  HaltDisposition,
  HaltKind,
  LedgerTask,
  RecordedHalt,
} from "./schemas";

export type OutcomeState =
  | { kind: "settled"; outcome: unknown }
  | { kind: "uncertain"; evidence: string };

export type ContextInput =
  | {
      kind: "outcome";
      cause: string;
      request: ContextEffectRequest;
      state: OutcomeState;
    }
  | { kind: "withdrawn"; cause: string; request: ContextEffectRequest }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "cancel" }
  | { kind: "steer"; id: string; instruction: string }
  | {
      kind: "decide";
      candidateId: string;
      decision: "approved" | "rejected";
      notes?: string;
      decidedAt: string;
    }
  | { kind: "disposition"; disposition: HaltDisposition; occurrence: string; at: string }
  | { kind: "amend"; contract: ContextContract; reason: string; at: string }
  | { kind: "reconcile_failed"; detail: string };

export class ContextInputRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextInputRefusedError";
  }
}

/** Whether an error is a Context refusal, judged by name as Run refusals are (see `isRunRefusal`). */
export function isContextRefusal(error: unknown): error is Error {
  return error instanceof Error && error.name === "ContextInputRefusedError";
}

/**
 * Applies one input to a Context's facts. Handlers record what they observed;
 * none assigns lifecycle or invalidates downstream proof, which lapses by
 * binding to the candidate. Pure: the caller persists the result atomically.
 */
export function advanceContext(
  facts: ContextFacts,
  input: ContextInput,
): ContextFacts {
  switch (input.kind) {
    case "outcome":
      return input.state.kind === "uncertain"
        ? halt(facts, {
            kind: "effect_uncertain",
            detail: input.state.evidence,
            ...seatOf(input.request),
          })
        : applyOutcome(facts, input.cause, input.request, input.state.outcome);
    case "withdrawn":
      return releaseAllowance(facts, input.cause);
    case "pause":
      return { ...facts, control: { ...facts.control, paused: true } };
    case "resume":
      return { ...facts, control: { ...facts.control, paused: false } };
    case "cancel":
      return { ...facts, control: { ...facts.control, cancelled: true } };
    case "steer":
      return {
        ...facts,
        control: {
          ...facts.control,
          steers: [
            ...facts.control.steers,
            { id: input.id, instruction: input.instruction, consumed: false },
          ],
        },
      };
    case "decide":
      return decide(facts, input);
    case "disposition":
      return applyDisposition(facts, input);
    case "amend":
      return amend(facts, input.contract, input.reason, input.at);
    case "reconcile_failed":
      return halt(facts, { kind: "reconcile_failed", detail: input.detail });
  }
}

function seatOf(request: ContextEffectRequest): { seat?: string } {
  return "seat" in request ? { seat: request.seat.assignmentId } : {};
}

function halt(facts: ContextFacts, recorded: RecordedHalt): ContextFacts {
  return { ...facts, control: { ...facts.control, halt: recorded } };
}

function applyOutcome(
  facts: ContextFacts,
  cause: string,
  request: ContextEffectRequest,
  outcome: unknown,
): ContextFacts {
  switch (request.kind) {
    case "work":
    case "capture_output":
    case "review":
    case "advise": {
      const report = conversationReportSchema.parse(outcome);
      const withSeat = recordSeatConversation(
        facts,
        request.seat.assignmentId,
        report,
      );
      return applyConversationReport(withSeat, cause, request, report);
    }
    case "bind":
    case "freeze":
    case "check":
    case "verify":
    case "accept":
      return applyWorkspaceReport(facts, request, outcome);
    case "answer":
      return applyAnswer(facts, request.questionId, outcome);
  }
}

function recordSeatConversation(
  facts: ContextFacts,
  assignmentId: string,
  report: ConversationReport,
): ContextFacts {
  if (facts.seats.conversations[assignmentId] === report.conversationId)
    return facts;
  return {
    ...facts,
    seats: {
      ...facts.seats,
      conversations: {
        ...facts.seats.conversations,
        [assignmentId]: report.conversationId,
      },
    },
  };
}

function applyConversationReport(
  facts: ContextFacts,
  cause: string,
  request: Extract<
    ContextEffectRequest,
    { kind: "work" | "capture_output" | "review" | "advise" }
  >,
  report: ConversationReport,
): ContextFacts {
  switch (request.kind) {
    case "work":
      return applyWorkReport(facts, cause, request, report);
    case "capture_output":
      return applyCaptureReport(facts, report);
    case "review":
      return applyReviewReport(facts, request, report);
    case "advise":
      return applyAdviceReport(facts, request, report);
  }
}

function unexpectedEnd(
  facts: ContextFacts,
  report: ConversationReport,
  seat: string,
): ContextFacts | null {
  if (report.status === "succeeded") return null;
  if (report.status === "cancelled" && facts.control.cancelled) return facts;
  if (report.status === "interrupted") {
    return halt(facts, {
      kind: "interrupted",
      detail: report.failure ?? "The turn was interrupted before it settled",
      seat,
    });
  }
  return halt(facts, {
    kind: "turn_failed",
    detail:
      report.failure ??
      (report.status === "cancelled"
        ? "The turn was cancelled outside this context"
        : "The turn failed"),
    seat,
  });
}

function applyWorkReport(
  initial: ContextFacts,
  cause: string,
  request: Extract<ContextEffectRequest, { kind: "work" }>,
  report: ConversationReport,
): ContextFacts {
  let facts =
    request.allowance !== null ? chargeAllowance(initial, cause) : initial;
  facts = startWorkEpoch(facts);
  if (request.steerId !== undefined) {
    const steerId = request.steerId;
    facts = {
      ...facts,
      control: {
        ...facts.control,
        steers: facts.control.steers.map((s) =>
          s.id === steerId ? { ...s, consumed: true } : s,
        ),
      },
    };
  }
  if (request.questionId !== undefined)
    facts = markContinued(facts, request.questionId);
  if (request.reason === "rework" && request.candidateId !== undefined) {
    facts = {
      ...facts,
      approval: {
        ...facts.approval,
        reworked: [...facts.approval.reworked, request.candidateId],
      },
    };
  }
  const ended = unexpectedEnd(facts, report, request.seat.assignmentId);
  if (ended !== null) return ended;
  facts = {
    ...facts,
    ledger: {
      ...facts.ledger,
      settledWorkTurns: facts.ledger.settledWorkTurns + 1,
      lastSummary: report.finalText,
    },
  };
  return openQuestion(facts, report.openQuestionId, request.seat.assignmentId);
}

function applyCaptureReport(
  facts: ContextFacts,
  report: ConversationReport,
): ContextFacts {
  // A capture turn is read-only: an interruption simply plans it again.
  if (report.status === "interrupted") return facts;
  const ended = unexpectedEnd(facts, report, "implementer");
  if (ended !== null) return ended;
  if (
    report.outputIssue === null &&
    report.structuredOutput !== undefined &&
    report.structuredOutput !== null
  ) {
    return {
      ...facts,
      candidates: {
        ...facts.candidates,
        captured: {
          output: report.structuredOutput,
          workTurn: facts.ledger.settledWorkTurns,
        },
      },
    };
  }
  const previous = facts.candidates.captureFailures;
  const workTurn = facts.ledger.settledWorkTurns;
  return {
    ...facts,
    candidates: {
      ...facts.candidates,
      captureFailures: {
        workTurn,
        count:
          previous !== null && previous.workTurn === workTurn
            ? previous.count + 1
            : 1,
        lastIssue:
          report.outputIssue ??
          "The capture turn returned no structured output",
      },
    },
  };
}

function applyReviewReport(
  initial: ContextFacts,
  request: Extract<ContextEffectRequest, { kind: "review" }>,
  report: ConversationReport,
): ContextFacts {
  let facts =
    request.questionId !== undefined
      ? markContinued(initial, request.questionId)
      : initial;
  const assignmentId = request.seat.assignmentId;
  // Reviews are read-only: an interrupted review is requested again.
  if (report.status === "interrupted") return facts;
  if (report.status === "cancelled" && facts.control.cancelled) return facts;
  if (report.status !== "succeeded") {
    return recordSeatVerdict(facts, {
      roundId: request.roundId,
      assignmentId,
      verdict: null,
      unavailableDetail: report.failure ?? "The review turn did not complete",
    });
  }
  if (report.openQuestionId !== null) {
    return openQuestion(facts, report.openQuestionId, assignmentId);
  }
  const verdict = parseReviewVerdict(report.structuredOutput);
  facts = recordSeatVerdict(facts, {
    roundId: request.roundId,
    assignmentId,
    verdict,
    ...(verdict === null
      ? {
          unavailableDetail:
            report.outputIssue ?? "The reviewer did not return a valid verdict",
        }
      : {}),
  });
  return facts;
}

function applyAdviceReport(
  facts: ContextFacts,
  request: Extract<ContextEffectRequest, { kind: "advise" }>,
  report: ConversationReport,
): ContextFacts {
  const ended = unexpectedEnd(facts, report, "implementer");
  if (ended !== null) return ended;
  const recorded = recordAdviceResponse(facts, {
    items: request.items,
    response: report.structuredOutput,
  });
  if (!recorded.complete) return recorded.facts;
  // The response may have changed files; acceptance waits for a comparison.
  return {
    ...recorded.facts,
    candidates: {
      ...recorded.facts.candidates,
      verifyPending: { roundId: request.roundId },
    },
  };
}

function applyWorkspaceReport(
  facts: ContextFacts,
  request: Extract<
    ContextEffectRequest,
    { kind: "bind" | "freeze" | "check" | "verify" | "accept" }
  >,
  outcome: unknown,
): ContextFacts {
  const report = workspaceReportSchema.parse(outcome);
  if (report.kind === "refused") {
    return halt(facts, { kind: "workspace_refused", detail: report.detail });
  }
  switch (request.kind) {
    case "bind":
      if (report.kind !== "bound") return facts;
      return { ...facts, binding: { ...facts.binding, bound: true } };
    case "freeze":
      if (report.kind !== "frozen") return facts;
      return freezeCandidate(facts, {
        contextId: facts.contextId,
        evidence: report.evidence,
      });
    case "check":
      if (report.kind !== "checked") return facts;
      return recordCheckResult(facts, {
        roundId: request.roundId,
        command: request.command,
        status: report.status,
        ...(report.detail !== undefined ? { detail: report.detail } : {}),
        wroteReviewedScope: report.wroteReviewedScope,
      });
    case "verify": {
      if (report.kind !== "verified") return facts;
      const cleared = {
        ...facts,
        candidates: { ...facts.candidates, verifyPending: null },
      };
      if (!report.changed) return cleared;
      const retired = retireCurrent(cleared, "advised");
      return {
        ...retired,
        candidates: {
          ...retired.candidates,
          nextProvenance: { kind: "advice_response", roundId: request.roundId },
        },
      };
    }
    case "accept":
      if (report.kind === "accepted") {
        return {
          ...facts,
          acceptance: {
            receipts: [
              ...facts.acceptance.receipts,
              { candidateId: request.candidateId, receipt: report.receipt },
            ],
          },
        };
      }
      return report.kind === "candidate_changed"
        ? retireCurrent(facts, "changed")
        : facts;
  }
}

function applyAnswer(
  facts: ContextFacts,
  questionId: string,
  outcome: unknown,
): ContextFacts {
  const report = requestsReportSchema.parse(outcome);
  const open = facts.requests.open.find((q) => q.questionId === questionId);
  if (open === undefined) return facts;
  const remaining = facts.requests.open.filter(
    (q) => q.questionId !== questionId,
  );
  if (report.kind === "withdrawn") {
    return { ...facts, requests: { ...facts.requests, open: remaining } };
  }
  return {
    ...facts,
    requests: {
      open: remaining,
      answered: [
        ...facts.requests.answered,
        {
          questionId,
          seat: open.seat,
          question: report.question,
          answer: report.answer,
          continued: false,
        },
      ],
    },
  };
}

function openQuestion(
  facts: ContextFacts,
  questionId: string | null,
  seat: string,
): ContextFacts {
  if (questionId === null) return facts;
  if (facts.requests.open.some((q) => q.questionId === questionId))
    return facts;
  return {
    ...facts,
    requests: {
      ...facts.requests,
      open: [...facts.requests.open, { questionId, seat }],
    },
  };
}

function markContinued(facts: ContextFacts, questionId: string): ContextFacts {
  return {
    ...facts,
    requests: {
      ...facts.requests,
      answered: facts.requests.answered.map((a) =>
        a.questionId === questionId ? { ...a, continued: true } : a,
      ),
    },
  };
}

function decide(
  facts: ContextFacts,
  input: Extract<ContextInput, { kind: "decide" }>,
): ContextFacts {
  const progress = nextProgress(facts);
  if (
    progress.kind !== "waiting" ||
    progress.obligation.kind !== "await_approval" ||
    progress.obligation.candidateId !== input.candidateId
  ) {
    throw new ContextInputRefusedError(
      `Candidate ${input.candidateId} is not awaiting a human decision`,
    );
  }
  return recordDecision(facts, {
    candidateId: input.candidateId,
    decision: input.decision,
    ...(input.notes !== undefined ? { notes: input.notes } : {}),
    decidedAt: input.decidedAt,
  });
}

/** The halt a disposition must clear, recorded or derived. */
export function currentHalt(facts: ContextFacts): HaltKind | null {
  if (facts.control.halt !== null) return facts.control.halt.kind;
  const progress = nextProgress(facts);
  return progress.kind === "halted" ? progress.halt : null;
}

/** Which dispositions clear each halt; owners read it to know their options. */
export const DISPOSITIONS_BY_HALT: Readonly<
  Record<HaltKind, ReadonlyArray<HaltDisposition["kind"]>>
> = {
  retries_exhausted: ["grant"],
  output_invalid: ["retry_capture"],
  candidate_unstable: ["continue"],
  plan_defect: ["rereview"],
  advice_invalid: ["retry_advice"],
  unavailable: ["retry"],
  turn_failed: ["continue", "replace_seat", "confirm_effect"],
  interrupted: ["continue", "replace_seat", "confirm_effect"],
  effect_uncertain: ["continue", "confirm_effect"],
  reconcile_failed: ["continue"],
  workspace_refused: ["continue"],
};

function applyDisposition(
  facts: ContextFacts,
  input: Extract<ContextInput, { kind: "disposition" }>,
): ContextFacts {
  const { disposition } = input;
  const haltKind = currentHalt(facts);
  if (haltKind === null) {
    throw new ContextInputRefusedError("The context is not halted");
  }
  if (!DISPOSITIONS_BY_HALT[haltKind].includes(disposition.kind)) {
    throw new ContextInputRefusedError(
      `Disposition ${disposition.kind} does not clear a ${haltKind} halt`,
    );
  }
  const cleared = {
    ...facts,
    control: {
      ...facts.control,
      halt: null,
      dispositions: [
        ...facts.control.dispositions,
        { occurrence: input.occurrence, halt: haltKind, disposition, at: input.at },
      ],
    },
  };
  switch (disposition.kind) {
    case "grant":
      return grantAllowance(cleared, disposition.allowance, disposition.count);
    case "retry_capture":
      return {
        ...cleared,
        candidates: { ...cleared.candidates, captureFailures: null },
      };
    case "continue":
      return haltKind === "candidate_unstable"
        ? {
            ...cleared,
            candidates: { ...cleared.candidates, unstableCount: 0 },
          }
        : cleared;
    case "rereview":
    case "retry": {
      const candidate = currentCandidate(cleared);
      const round = candidate === null ? null : activeRound(cleared, candidate);
      return round === null ? cleared : retireRound(cleared, round.id);
    }
    case "retry_advice":
      return {
        ...cleared,
        advice: { ...cleared.advice, correctionFailures: 0 },
      };
    case "replace_seat": {
      const seat = facts.control.halt?.seat ?? "implementer";
      const conversations = { ...cleared.seats.conversations };
      delete conversations[seat];
      return {
        ...cleared,
        seats: {
          conversations,
          replacements: {
            ...cleared.seats.replacements,
            [seat]: (cleared.seats.replacements[seat] ?? 0) + 1,
          },
        },
      };
    }
    case "confirm_effect":
      return cleared;
  }
}

function amend(
  facts: ContextFacts,
  contract: ContextContract,
  reason: string,
  at: string,
): ContextFacts {
  const revision = facts.contract.revision + 1;
  const existing = new Map(facts.ledger.tasks.map((t) => [t.id, t]));
  const contractTasks: LedgerTask[] = contract.tasks.map((task) => ({
    id: task.id,
    title: task.title,
    ...(task.instructions !== undefined
      ? { instructions: task.instructions }
      : {}),
    source: "contract",
    status: existing.get(task.id)?.status ?? "open",
  }));
  const agentTasks = facts.ledger.tasks.filter((t) => t.source === "agent");
  return {
    ...facts,
    contract: {
      revision,
      current: contract,
      amendments: [...facts.contract.amendments, { revision, reason, at }],
    },
    ledger: {
      ...facts.ledger,
      tasks: [...contractTasks, ...agentTasks],
      revision: facts.ledger.revision + 1,
    },
  };
}
