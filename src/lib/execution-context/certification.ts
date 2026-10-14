import { z } from "zod";
import type {
  Candidate,
  CheckResult,
  ContextFacts,
  Finding,
  ReviewRound,
  ReviewerAssignment,
  RoundKind,
  SeatVerdict,
} from "./schemas";
import { findingSchema } from "./schemas";

const reviewVerdictSchema = z
  .object({
    verdict: z.enum(["pass", "fail", "plan_defect"]),
    findings: z.array(findingSchema),
    advisories: z.array(findingSchema),
  })
  .strict();
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

/** Output contract every reviewer seat returns, generated from the parser's schema. */
export const REVIEW_VERDICT_OUTPUT_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(reviewVerdictSchema);

export function parseReviewVerdict(value: unknown): ReviewVerdict | null {
  const parsed = reviewVerdictSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export type CertificationStanding =
  | { kind: "not_required" }
  | { kind: "pending"; roundKind: RoundKind; round: ReviewRound | null }
  | { kind: "cleared"; round: ReviewRound; blocking: boolean }
  | { kind: "failed"; round: ReviewRound; findings: Finding[] }
  | { kind: "defect"; round: ReviewRound; findings: Finding[] }
  | { kind: "unavailable"; round: ReviewRound; detail: string };

/** A candidate produced by an advisory response needs blocking review only. */
export function requiredRoundKind(candidate: Candidate): RoundKind {
  return candidate.provenance.kind === "advice_response" ? "blocking" : "full";
}

function roundSeats(
  reviewers: ReviewerAssignment[],
  kind: RoundKind,
): ReviewerAssignment[] {
  return kind === "full"
    ? reviewers
    : reviewers.filter((r) => r.authority === "blocking");
}

export function activeRound(
  facts: ContextFacts,
  candidate: Candidate,
): ReviewRound | null {
  const kind = requiredRoundKind(candidate);
  for (let i = facts.certification.rounds.length - 1; i >= 0; i -= 1) {
    const round = facts.certification.rounds[i];
    if (round === undefined) continue;
    if (round.candidateId === candidate.id && round.kind === kind) {
      return round.retired ? null : round;
    }
  }
  return null;
}

export function certificationStanding(
  facts: ContextFacts,
  candidate: Candidate,
): CertificationStanding {
  const contract = facts.contract.current;
  const kind = requiredRoundKind(candidate);
  const seats = roundSeats(contract.reviewers, kind);
  if (contract.checks.length === 0 && seats.length === 0) {
    return { kind: "not_required" };
  }
  const round = activeRound(facts, candidate);
  if (round === null) return { kind: "pending", roundKind: kind, round: null };

  const failedChecks = round.checks.filter((c) => c.status === "failed");
  const unavailableCheck = round.checks.find((c) => c.status === "unavailable");
  if (unavailableCheck !== undefined) {
    return {
      kind: "unavailable",
      round,
      detail: `Acceptance check ${unavailableCheck.command} could not run${unavailableCheck.detail ? `: ${unavailableCheck.detail}` : ""}`,
    };
  }
  if (failedChecks.length > 0) {
    return { kind: "failed", round, findings: failedChecks.map(checkFinding) };
  }
  if (round.checks.some((c) => c.status === "pending")) {
    return { kind: "pending", roundKind: kind, round };
  }

  const blocking = round.seats.filter((s) => s.authority === "blocking");
  const unavailableSeat = blocking.find((s) => s.status === "unavailable");
  if (unavailableSeat !== undefined) {
    return {
      kind: "unavailable",
      round,
      detail: `Required reviewer ${unavailableSeat.assignmentId} is unavailable${unavailableSeat.detail ? `: ${unavailableSeat.detail}` : ""}`,
    };
  }
  if (round.seats.some((s) => s.status === "pending")) {
    return { kind: "pending", roundKind: kind, round };
  }
  const defects = blocking.filter((s) => s.status === "defect");
  if (defects.length > 0) {
    return {
      kind: "defect",
      round,
      findings: defects.flatMap((s) => s.findings),
    };
  }
  const failures = blocking.filter((s) => s.status === "fail");
  if (failures.length > 0) {
    return {
      kind: "failed",
      round,
      findings: failures.flatMap((s) => s.findings),
    };
  }
  return {
    kind: "cleared",
    round,
    blocking: contract.checks.length > 0 || blocking.length > 0,
  };
}

function checkFinding(check: CheckResult): Finding {
  return {
    title: `Acceptance check ${check.command} failed`,
    description: check.detail ?? "The command reported a failure.",
  };
}

export function openRound(
  facts: ContextFacts,
  input: { contextId: string; candidate: Candidate; at: string },
): ContextFacts {
  const contract = facts.contract.current;
  const kind = requiredRoundKind(input.candidate);
  const sequence = facts.certification.sequence + 1;
  const round: ReviewRound = {
    id: `${input.contextId}:round:${sequence}`,
    candidateId: input.candidate.id,
    kind,
    checks: contract.checks.map((command) => ({ command, status: "pending" })),
    seats: roundSeats(contract.reviewers, kind).map((seat) => ({
      assignmentId: seat.id,
      authority: seat.authority,
      status: "pending",
      findings: [],
      advisories: [],
    })),
    retired: false,
    openedAt: input.at,
  };
  return {
    ...facts,
    certification: { sequence, rounds: [...facts.certification.rounds, round] },
  };
}

function updateRound(
  facts: ContextFacts,
  roundId: string,
  update: (round: ReviewRound) => ReviewRound,
): ContextFacts {
  const target = facts.certification.rounds.find((r) => r.id === roundId);
  // A result for a superseded or unknown round is evidence only.
  if (target === undefined || target.retired) return facts;
  return {
    ...facts,
    certification: {
      ...facts.certification,
      rounds: facts.certification.rounds.map((r) =>
        r.id === roundId ? update(r) : r,
      ),
    },
  };
}

export function recordCheckResult(
  facts: ContextFacts,
  input: {
    roundId: string;
    command: string;
    status: "passed" | "failed" | "unavailable";
    detail?: string;
    /** Paths in the reviewed scope the command changed; a reader may change none. */
    wroteReviewedScope: string[];
  },
): ContextFacts {
  const wrote = input.wroteReviewedScope;
  const status =
    wrote.length > 0 && input.status === "passed" ? "failed" : input.status;
  const detail =
    wrote.length > 0
      ? `The command changed reviewed files: ${wrote.join(", ")}. Acceptance checks must not write the reviewed scope.${input.detail ? ` ${input.detail}` : ""}`
      : input.detail;
  return updateRound(facts, input.roundId, (round) => ({
    ...round,
    checks: round.checks.map((check) =>
      check.command === input.command
        ? {
            command: check.command,
            status,
            ...(detail !== undefined ? { detail } : {}),
          }
        : check,
    ),
  }));
}

export function recordSeatVerdict(
  facts: ContextFacts,
  input: {
    roundId: string;
    assignmentId: string;
    verdict: ReviewVerdict | null;
    unavailableDetail?: string;
  },
): ContextFacts {
  return updateRound(facts, input.roundId, (round) => ({
    ...round,
    seats: round.seats.map((seat): SeatVerdict => {
      if (seat.assignmentId !== input.assignmentId) return seat;
      if (input.verdict === null) {
        return {
          ...seat,
          status: "unavailable",
          ...(input.unavailableDetail !== undefined
            ? { detail: input.unavailableDetail }
            : {}),
        };
      }
      return {
        ...seat,
        status:
          input.verdict.verdict === "pass"
            ? "pass"
            : input.verdict.verdict === "fail"
              ? "fail"
              : "defect",
        findings: input.verdict.findings,
        advisories: input.verdict.advisories,
      };
    }),
  }));
}

export function retireRound(
  facts: ContextFacts,
  roundId: string,
): ContextFacts {
  return {
    ...facts,
    certification: {
      ...facts.certification,
      rounds: facts.certification.rounds.map((r) =>
        r.id === roundId ? { ...r, retired: true } : r,
      ),
    },
  };
}
