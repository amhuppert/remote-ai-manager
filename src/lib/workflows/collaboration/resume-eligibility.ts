/**
 * Whether a failed collaboration may be resumed, decided before anything moves.
 *
 * Resume is a promise about the future — "this run can still finish" — and the
 * only honest way to keep it is to refuse the cases where it cannot. Every gate
 * here is a refusal the UI can explain, not a silent best effort.
 *
 * The two window gates deserve their reason stated. A run that reached a
 * clarification gate, or that began its final answer, is NOT resumed:
 *
 *  - `open_conflicts` on the log proves questions were *generated*, never that
 *    the user saw or answered them. The pause is persisted after the artifact
 *    is appended, so a crash in between leaves questions nobody was shown.
 *    Resuming past them would silently discard the user's say.
 *  - `final_answer` on the log means delivery to the conversation transcript
 *    may already have happened; the append is not idempotent and carries no
 *    stable id. Resuming could post the answer twice.
 *
 * Both windows are recoverable in principle, with a consent receipt and a
 * content-bound idempotent delivery. Neither is in this change, so both refuse.
 */

import {
  collaborationFailureClass,
  type CollaborationFailureCause,
} from "./failure-cause";
import type { CollaborationStepLedger, LedgerRejection } from "./step-ledger";

export type ResumeRefusal =
  | { code: "not_failed"; status: string }
  | { code: "terminal_failure"; cause: CollaborationFailureCause }
  | { code: "premise_missing"; detail: string }
  | { code: "ledger_unusable"; rejection: LedgerRejection }
  | { code: "reached_gate" }
  | { code: "reached_final" }
  | { code: "lost_progress"; recordedRounds: number };

export type ResumeEligibility =
  | { kind: "eligible" }
  | { kind: "refused"; refusal: ResumeRefusal };

export interface ResumeEligibilityInput {
  status: string;
  /** Why the run failed. Absent on envelopes written before causes were
   *  recorded — treated as un-resumable rather than guessed at. */
  failureCause: CollaborationFailureCause | null;
  /** Null when the recorded stream could not be turned into a ledger. */
  ledger: CollaborationStepLedger | null;
  ledgerRejection: LedgerRejection | null;
  /** Names of executable premises the envelope does not carry. */
  missingPremises: readonly string[];
  /** Rounds the envelope's own snapshot claims were completed. Used only to
   *  catch a stream that has gone missing under a run that made progress. */
  snapshotRoundsCompleted: number;
}

export function decideResumeEligibility(
  input: ResumeEligibilityInput,
): ResumeEligibility {
  const refuse = (refusal: ResumeRefusal): ResumeEligibility => ({
    kind: "refused",
    refusal,
  });

  if (input.status !== "failed") {
    return refuse({ code: "not_failed", status: input.status });
  }

  if (input.failureCause === null) {
    return refuse({
      code: "premise_missing",
      detail: "the run did not record why it failed",
    });
  }
  if (collaborationFailureClass(input.failureCause) !== "operational") {
    return refuse({ code: "terminal_failure", cause: input.failureCause });
  }

  if (input.missingPremises.length > 0) {
    return refuse({
      code: "premise_missing",
      detail: input.missingPremises.join(", "),
    });
  }

  if (input.ledgerRejection !== null) {
    return refuse({
      code: "ledger_unusable",
      rejection: input.ledgerRejection,
    });
  }

  // An empty stream under a run whose snapshot recorded progress is data loss,
  // not a fresh start: resuming would re-run and re-bill work that happened.
  if (input.ledger === null) {
    if (input.snapshotRoundsCompleted > 0) {
      return refuse({
        code: "lost_progress",
        recordedRounds: input.snapshotRoundsCompleted,
      });
    }
    return { kind: "eligible" };
  }

  if (input.ledger.reachedGate) return refuse({ code: "reached_gate" });
  if (input.ledger.reachedFinal) return refuse({ code: "reached_final" });

  return { kind: "eligible" };
}

/** User-facing explanation. Every refusal names restart as the way forward,
 *  because in every one of these cases it genuinely is. */
export function describeResumeRefusal(refusal: ResumeRefusal): string {
  const restart = "Start a new collaboration to continue this work.";
  switch (refusal.code) {
    case "not_failed":
      return `This collaboration is ${refusal.status}, not failed, so there is nothing to resume.`;
    case "terminal_failure":
      return refusal.cause.kind === "policy_fail"
        ? `The agents ended this collaboration by deciding it could not be resolved, so resuming would reach the same conclusion. ${restart}`
        : `This collaboration cannot be resumed (${refusal.cause.kind}). ${restart}`;
    case "premise_missing":
      return `This collaboration is missing the settings a resumed run would need (${refusal.detail}). ${restart}`;
    case "ledger_unusable":
      return `The saved record of this collaboration cannot be replayed safely (${refusal.rejection.code}). ${restart}`;
    case "reached_gate":
      return `This collaboration had already asked you a question when it failed, and resuming could skip past it. ${restart}`;
    case "reached_final":
      return `This collaboration had already begun writing its final answer when it failed, and resuming could deliver it twice. ${restart}`;
    case "lost_progress":
      return `The saved record of this collaboration's ${refusal.recordedRounds} completed round(s) is no longer readable. ${restart}`;
  }
}
