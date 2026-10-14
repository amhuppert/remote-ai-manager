import { adviceStanding } from "./advice";
import { allowanceAvailable } from "./allowances";
import { approvalStanding } from "./approval";
import {
  candidateUnstable,
  captureExhausted,
  currentCandidate,
  needsOutputCapture,
} from "./candidates";
import { certificationStanding } from "./certification";
import { openTasks } from "./ledger";
import type {
  ContextFacts,
  ContextProgress,
  Obligation,
  SettledProgress,
} from "./schemas";

/** A pending intent as progress sees it: what it is and whether it was admitted. */
export interface EffectView {
  cause: string;
  admitted: boolean;
  /** Effects that wait on a person rather than run. */
  waitsOnPerson: boolean;
}

/**
 * The only combination of the private owners' summaries. Pure: handlers record
 * facts, and this function decides what those facts mean for progress.
 */
export function deriveProgress(
  facts: ContextFacts,
  effects: readonly EffectView[],
): ContextProgress {
  const control = facts.control;
  const admitted = effects.some((effect) => effect.admitted);
  if (control.cancelled)
    return admitted ? { kind: "stopping" } : { kind: "cancelled" };
  if (control.halt !== null) {
    return {
      kind: "halted",
      halt: control.halt.kind,
      detail: control.halt.detail,
    };
  }
  if (control.paused) {
    return admitted
      ? { kind: "paused", next: null, draining: true }
      : { kind: "paused", next: nextProgress(facts), draining: false };
  }
  const next = nextProgress(facts);
  if (effects.length === 0) return next;
  if (next.kind === "running" || next.kind === "waiting") {
    const waiting = effects.every((effect) => effect.waitsOnPerson);
    return {
      kind: waiting ? "waiting" : "running",
      obligation: next.obligation,
    };
  }
  return next;
}

/** The first unsatisfied step of the acceptance chain. */
export function nextProgress(facts: ContextFacts): SettledProgress {
  if (!facts.binding.bound) return running({ kind: "bind" });

  const steer = facts.control.steers.find((s) => !s.consumed);
  if (steer !== undefined) return running({ kind: "work", reason: "steer" });

  const open = facts.requests.open[0];
  if (open !== undefined) {
    return waiting({ kind: "await_answer", questionId: open.questionId });
  }
  if (facts.requests.answered.some((a) => !a.continued)) {
    return running({ kind: "work", reason: "continue" });
  }

  // Every context takes its initial work turn, task list or not.
  if (facts.ledger.settledWorkTurns === 0) {
    return running({ kind: "work", reason: "initial" });
  }
  if (openTasks(facts).length > 0) {
    return allowanceAvailable(facts, "unfinishedTaskRetries")
      ? running({ kind: "work", reason: "retry" })
      : halted(
          "retries_exhausted",
          "Tasks remain open and no unfinished-task retries are left",
        );
  }

  const candidate = currentCandidate(facts);
  if (candidate === null) {
    if (candidateUnstable(facts)) {
      return halted(
        "candidate_unstable",
        "The reviewed files kept changing before acceptance",
      );
    }
    if (captureExhausted(facts)) {
      return halted(
        "output_invalid",
        facts.candidates.captureFailures?.lastIssue ?? "Output capture failed",
      );
    }
    return needsOutputCapture(facts)
      ? running({ kind: "capture_output" })
      : running({ kind: "freeze" });
  }

  const certification = certificationStanding(facts, candidate);
  switch (certification.kind) {
    case "pending":
      return running({ kind: "certify", roundKind: certification.roundKind });
    case "unavailable":
      return halted("unavailable", certification.detail);
    case "defect":
      return halted(
        "plan_defect",
        certification.findings.map((f) => f.title).join("; ") ||
          "A reviewer reported a plan defect",
      );
    case "failed":
      return allowanceAvailable(facts, "validationRetries")
        ? running({ kind: "work", reason: "remediate" })
        : halted(
            "retries_exhausted",
            "Blocking review failed and no validation retries are left",
          );
    case "cleared":
    case "not_required":
      break;
  }

  const advice = adviceStanding(facts, certification);
  if (advice.kind === "invalid") {
    return halted(
      "advice_invalid",
      "The advisory response did not give one valid disposition per advisory",
    );
  }
  if (advice.kind === "owed") return running({ kind: "advise" });
  if (facts.candidates.verifyPending !== null)
    return running({ kind: "verify" });

  const approval = approvalStanding(facts, candidate);
  if (approval.kind === "pending") {
    return waiting({ kind: "await_approval", candidateId: candidate.id });
  }
  if (approval.kind === "rejected") {
    return running({ kind: "work", reason: "rework" });
  }

  const accepted = facts.acceptance.receipts.some(
    (r) => r.candidateId === candidate.id,
  );
  if (!accepted) return running({ kind: "accept", candidateId: candidate.id });

  return { kind: "succeeded", candidateId: candidate.id };
}

function running(obligation: Obligation): SettledProgress {
  return { kind: "running", obligation };
}

function waiting(obligation: Obligation): SettledProgress {
  return { kind: "waiting", obligation };
}

function halted(
  halt: Extract<SettledProgress, { kind: "halted" }>["halt"],
  detail: string,
): SettledProgress {
  return { kind: "halted", halt, detail };
}
