/**
 * Deterministic post-parse guards for compaction envelopes
 * (docs/design/conversation-compaction/README.md §7.3). Pure code, not model
 * judgment: the orchestrator feeds guard violations back to the model on
 * retry, so every violation string names the offending field and the rule.
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

export type CompactionGuardResult =
  | { ok: true }
  | { ok: false; violations: string[] };

interface AnchoredArray {
  name: string;
  items: { sourceRefs: SourceRef[] }[];
}

function collectCoverageViolations(
  envelope: CompactionEnvelope,
  ctx: CompactionGuardContext,
  violations: string[],
): void {
  const { coveredStartSeq, coveredEndSeq } = envelope.source;
  const { startSeq, endSeq } = ctx.expectedCoverage;

  if (coveredStartSeq !== startSeq) {
    violations.push(
      `source.coveredStartSeq is ${coveredStartSeq} but this run covers lines starting at seq ${startSeq}`,
    );
  }
  if (coveredEndSeq !== endSeq) {
    violations.push(
      `source.coveredEndSeq is ${coveredEndSeq} but this run covers lines ending at seq ${endSeq}`,
    );
  }
}

function collectDeltaViolations(
  envelope: CompactionEnvelope,
  ctx: CompactionGuardContext,
  violations: string[],
): void {
  const previous = ctx.previousEnvelope;
  if (!previous) {
    violations.push(
      "delta run is missing the previous envelope required for continuity checks",
    );
    return;
  }

  if (envelope.source.coveredStartSeq !== previous.source.coveredStartSeq) {
    violations.push(
      `delta must keep source.coveredStartSeq at ${previous.source.coveredStartSeq} (got ${envelope.source.coveredStartSeq})`,
    );
  }
  if (envelope.source.coveredEndSeq < previous.source.coveredEndSeq) {
    violations.push(
      `coverage must extend monotonically: source.coveredEndSeq ${envelope.source.coveredEndSeq} regressed below the previous envelope's ${previous.source.coveredEndSeq}`,
    );
  }

  const statements = new Set(
    envelope.decisions.map((decision) => decision.statement),
  );
  for (const previousDecision of previous.decisions) {
    if (previousDecision.status === "superseded") continue;
    if (!statements.has(previousDecision.statement)) {
      violations.push(
        `previous decision was dropped: ${JSON.stringify(previousDecision.statement)} must stay in decisions — mark it status "superseded" instead of removing it`,
      );
    }
  }
}

function collectSourceRefViolations(
  envelope: CompactionEnvelope,
  violations: string[],
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
          violations.push(
            `${at} has seqStart ${ref.seqStart} greater than seqEnd ${ref.seqEnd}`,
          );
          return;
        }
        if (ref.seqStart < coveredStartSeq || ref.seqEnd > coveredEndSeq) {
          violations.push(
            `${at} spans seq ${ref.seqStart}–${ref.seqEnd}, outside the covered range ${coveredStartSeq}–${coveredEndSeq}`,
          );
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
  const violations: string[] = [];

  collectCoverageViolations(envelope, ctx, violations);
  if (ctx.mode === "delta") {
    collectDeltaViolations(envelope, ctx, violations);
  }
  collectSourceRefViolations(envelope, violations);

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
