/**
 * Probe evidence and its two audiences.
 *
 * The protected record keeps the raw provider references, because telling a
 * retired session from a fresh one is the whole claim and a digest cannot be
 * compared against a provider's own logs. The public report keeps the same
 * claim in a form that is safe to publish: references become digests, model
 * answers become bounded excerpts, and an unavailable measurement stays
 * unavailable rather than becoming a zero.
 */

import { createHash } from "node:crypto";

import type { ContinuityExpectationKind } from "@/lib/conversation-checkpoints/fixtures/continuity-corpus";

import type { ProbeModelSelection } from "./environment";

import type { ProbeCall, ProbeCallTotals } from "./budget";

/** Longest model answer the public report reproduces. */
export const PUBLIC_ANSWER_EXCERPT_BYTES = 240;

export interface ProbeAnswerEvidence {
  expectationId: string;
  kind: ContinuityExpectationKind;
  question: string;
  answer: string;
  satisfied: boolean;
  missing: readonly string[];
  forbidden: readonly string[];
}

export interface ProbeCycleEvidence {
  cycle: number;
  operationId: string;
  ordinal: number;
  phase: string;
  seedSha256: string;
  seedBytes: number;
  generationPassCount: number | null;
  compactionCostUsd: number | null;
  /** The reference retirement cleared. Raw: protected evidence only. */
  priorBackendRef: string | null;
  /** The reference the fresh runtime reported. Raw: protected evidence only. */
  acceptedBackendRef: string | null;
  queuedMessageIds: readonly string[];
  queuedAttemptId: string | null;
  /** `checkpoint.fresh_runtime` occurrences for this operation. */
  freshRuntimeEvents: number;
  /**
   * Whether each of those runtimes was created with a resume handle. All
   * false is the claim that nothing resumed or forked the retired session.
   */
  freshRuntimeResumeRefs: readonly (boolean | null)[];
  /** `checkpoint.delivery.accepted` occurrences for this operation. */
  acceptedEvents: number;
  /** `prompt.resume_ref_missing` occurrences during this cycle. */
  resumeRefMissingEvents: number;
  /** Whether any turn after the delivery turn carried the seed again. */
  seedReinjectedAfterDelivery: boolean;
  answers: readonly ProbeAnswerEvidence[];
}

export interface ProbeRunEvidence {
  runId: string;
  backend: string;
  scope: "session" | "project";
  startedAt: string;
  finishedAt: string;
  configDir: string;
  conversationId: string;
  worktreePath: string;
  transcriptPath: string;
  /** Shipped descriptor claim, and whether the probe had to override it. */
  descriptorCheckpointCapability: { shipped: boolean; overridden: boolean };
  /** The model this run certifies, or null when CC's default was used. */
  modelSelection: ProbeModelSelection | null;
  cycles: readonly ProbeCycleEvidence[];
  callTotals: ProbeCallTotals;
  /**
   * Every provider call this run made, in order, with the price the backend
   * that ran it actually reported. Kept alongside the totals because a total
   * cannot show which calls were priced and which were unavailable.
   */
  calls: readonly ProbeCall[];
  outcome: "passed" | "failed";
  failures: readonly string[];
}

export interface PublicCycleReport extends Omit<
  ProbeCycleEvidence,
  "priorBackendRef" | "acceptedBackendRef" | "answers"
> {
  priorBackendRefDigest: string | null;
  acceptedBackendRefDigest: string | null;
  /** False proves the fresh runtime is not the retired one. */
  backendRefUnchanged: boolean;
  answers: readonly (Omit<ProbeAnswerEvidence, "answer"> & {
    answerExcerpt: string;
  })[];
}

export interface PublicRunReport extends Omit<
  ProbeRunEvidence,
  "cycles" | "configDir"
> {
  cycles: readonly PublicCycleReport[];
}

export function refDigest(ref: string): string {
  return `sha256:${createHash("sha256").update(ref, "utf-8").digest("hex")}`;
}

function excerpt(answer: string): string {
  return answer.length <= PUBLIC_ANSWER_EXCERPT_BYTES
    ? answer
    : `${answer.slice(0, PUBLIC_ANSWER_EXCERPT_BYTES - 1)}\u2026`;
}

export function toPublicRunReport(evidence: ProbeRunEvidence): PublicRunReport {
  const { configDir: _configDir, cycles, ...rest } = evidence;
  return {
    ...rest,
    cycles: cycles.map((cycle) => {
      const { priorBackendRef, acceptedBackendRef, answers, ...safe } = cycle;
      return {
        ...safe,
        priorBackendRefDigest:
          priorBackendRef === null ? null : refDigest(priorBackendRef),
        acceptedBackendRefDigest:
          acceptedBackendRef === null ? null : refDigest(acceptedBackendRef),
        backendRefUnchanged:
          priorBackendRef !== null && priorBackendRef === acceptedBackendRef,
        answers: answers.map(({ answer, ...graded }) => ({
          ...graded,
          answerExcerpt: excerpt(answer),
        })),
      };
    }),
  };
}

/** Every raw value the public report must not contain. */
export function protectedValues(evidence: ProbeRunEvidence): readonly string[] {
  const values = evidence.cycles.flatMap((cycle) => [
    cycle.priorBackendRef,
    cycle.acceptedBackendRef,
  ]);
  return [
    ...new Set(
      values.filter((value): value is string => value !== null && value !== ""),
    ),
  ];
}

export function assertNoProtectedLeak(
  serialized: string,
  secrets: readonly string[],
): void {
  const leaked = secrets.filter((secret) => serialized.includes(secret));
  if (leaked.length > 0) {
    throw new Error(
      `public report leaks ${leaked.length} protected provider reference(s)`,
    );
  }
}
