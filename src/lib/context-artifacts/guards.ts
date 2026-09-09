/**
 * Deterministic post-parse guards for compaction envelopes
 * (docs/design/conversation-compaction/README.md §7.3). Pure code, not model
 * judgment: the orchestrator feeds guard violations back to the model on
 * retry, so every violation names the offending field and the rule.
 *
 * A violation therefore has two channels. `message` is the repair text and may
 * quote the envelope — telling a model to restore a dropped decision without
 * saying which one is useless. `code` and `at` are the structural cause, and
 * are the only part a diagnostic may carry: checkpoint generation runs through
 * these same guards, and its logs may not repeat conversation material (R9.2).
 */

import type { SourceRef } from "@/lib/conversations/schemas";
import type { CompactionEnvelope } from "./schemas";

export type CompactionRunMode = "full" | "delta";

export interface CompactionGuardContext {
  mode: CompactionRunMode;
  /** Required when `mode === "delta"`; its absence is itself a violation. */
  previousEnvelope?: CompactionEnvelope;
  /** The coverage span the orchestrator rendered for this run. */
  expectedCoverage: { startSeq: number; endSeq: number };
}

export type CompactionGuardCode =
  | "coverage_start_mismatch"
  | "coverage_end_mismatch"
  | "delta_previous_envelope_missing"
  | "delta_coverage_start_changed"
  | "delta_coverage_regressed"
  | "delta_decision_dropped"
  | "source_ref_inverted"
  | "source_ref_out_of_range";

export interface CompactionGuardViolation {
  /** Structural cause. Safe to log. */
  code: CompactionGuardCode;
  /** Field coordinate of the offending value, never its content. Safe to log. */
  at: string;
  /** Model-facing repair text; may quote the envelope, so it is never logged. */
  message: string;
}

export type CompactionGuardResult =
  | { ok: true }
  | { ok: false; violations: CompactionGuardViolation[] };

interface AnchoredArray {
  name: string;
  items: { sourceRefs: SourceRef[] }[];
}

function collectCoverageViolations(
  envelope: CompactionEnvelope,
  ctx: CompactionGuardContext,
  violations: CompactionGuardViolation[],
): void {
  const { coveredStartSeq, coveredEndSeq } = envelope.source;
  const { startSeq, endSeq } = ctx.expectedCoverage;

  if (coveredStartSeq !== startSeq) {
    violations.push({
      code: "coverage_start_mismatch",
      at: "source.coveredStartSeq",
      message: `source.coveredStartSeq is ${coveredStartSeq} but this run covers lines starting at seq ${startSeq}`,
    });
  }
  if (coveredEndSeq !== endSeq) {
    violations.push({
      code: "coverage_end_mismatch",
      at: "source.coveredEndSeq",
      message: `source.coveredEndSeq is ${coveredEndSeq} but this run covers lines ending at seq ${endSeq}`,
    });
  }
}

function collectDeltaViolations(
  envelope: CompactionEnvelope,
  ctx: CompactionGuardContext,
  violations: CompactionGuardViolation[],
): void {
  const previous = ctx.previousEnvelope;
  if (!previous) {
    violations.push({
      code: "delta_previous_envelope_missing",
      at: "previousEnvelope",
      message:
        "delta run is missing the previous envelope required for continuity checks",
    });
    return;
  }

  if (envelope.source.coveredStartSeq !== previous.source.coveredStartSeq) {
    violations.push({
      code: "delta_coverage_start_changed",
      at: "source.coveredStartSeq",
      message: `delta must keep source.coveredStartSeq at ${previous.source.coveredStartSeq} (got ${envelope.source.coveredStartSeq})`,
    });
  }
  if (envelope.source.coveredEndSeq < previous.source.coveredEndSeq) {
    violations.push({
      code: "delta_coverage_regressed",
      at: "source.coveredEndSeq",
      message: `coverage must extend monotonically: source.coveredEndSeq ${envelope.source.coveredEndSeq} regressed below the previous envelope's ${previous.source.coveredEndSeq}`,
    });
  }

  const statements = new Set(
    envelope.decisions.map((decision) => decision.statement),
  );
  previous.decisions.forEach((previousDecision, index) => {
    if (previousDecision.status === "superseded") return;
    if (statements.has(previousDecision.statement)) return;
    violations.push({
      code: "delta_decision_dropped",
      at: `previous.decisions[${index}]`,
      message: `previous decision was dropped: ${JSON.stringify(previousDecision.statement)} must stay in decisions — mark it status "superseded" instead of removing it`,
    });
  });
}

function collectSourceRefViolations(
  envelope: CompactionEnvelope,
  violations: CompactionGuardViolation[],
): void {
  const { coveredStartSeq, coveredEndSeq } = envelope.source;
  const anchoredArrays: AnchoredArray[] = [
    { name: "decisions", items: envelope.decisions },
    { name: "files", items: envelope.files },
    { name: "commands", items: envelope.commands },
    { name: "openQuestions", items: envelope.openQuestions },
    { name: "blockers", items: envelope.blockers },
  ];

  for (const { name, items } of anchoredArrays) {
    items.forEach((item, itemIndex) => {
      item.sourceRefs.forEach((ref, refIndex) => {
        const at = `${name}[${itemIndex}].sourceRefs[${refIndex}]`;
        if (ref.seqStart > ref.seqEnd) {
          violations.push({
            code: "source_ref_inverted",
            at,
            message: `${at} has seqStart ${ref.seqStart} greater than seqEnd ${ref.seqEnd}`,
          });
          return;
        }
        if (ref.seqStart < coveredStartSeq || ref.seqEnd > coveredEndSeq) {
          violations.push({
            code: "source_ref_out_of_range",
            at,
            message: `${at} spans seq ${ref.seqStart}–${ref.seqEnd}, outside the covered range ${coveredStartSeq}–${coveredEndSeq}`,
          });
        }
      });
    });
  }
}

/**
 * Validate a parsed envelope against the deterministic §7.3 guards: coverage
 * matches the rendered window (and extends monotonically on delta), no live
 * previous decision silently dropped on delta, and every sourceRef in every
 * anchored array falls inside the envelope's covered range.
 */
export function validateCompactionGuards(
  envelope: CompactionEnvelope,
  ctx: CompactionGuardContext,
): CompactionGuardResult {
  const violations: CompactionGuardViolation[] = [];

  collectCoverageViolations(envelope, ctx, violations);
  if (ctx.mode === "delta") {
    collectDeltaViolations(envelope, ctx, violations);
  }
  collectSourceRefViolations(envelope, violations);

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
