import { describe, expect, it } from "vitest";

import { checkpointPhaseSchema, type CheckpointPhase } from "./schemas";
import {
  validateCheckpointOutcomeEdge,
  validateCheckpointTransition,
} from "./transitions";

const ALL_PHASES = checkpointPhaseSchema.options;

/**
 * The transition authority stated as data, independent of the implementation:
 * each entry is the complete set of phases reachable from one phase. Every
 * pair not listed here must be refused, so the table doubles as the negative
 * case and a new edge cannot be added without appearing here first.
 */
const EXPECTED_LEGAL: Readonly<Record<CheckpointPhase, CheckpointPhase[]>> = {
  // A build can freeze, fail, or be cancelled before anything is retired.
  building: ["retiring", "failed", "cancelled"],
  // Retirement either completes or becomes owned repair work.
  retiring: ["ready", "needs_reconciliation"],
  // A ready seed is consumed by the next admitted ordinary turn.
  ready: ["delivering", "needs_reconciliation"],
  // Acceptance, a definite pre-acceptance admission failure, or uncertainty.
  delivering: ["applied", "ready", "needs_reconciliation"],
  // An applied continuation that later becomes unusable needs recovery.
  applied: ["needs_reconciliation"],
  // Repair proves retirement finished, or repairs acceptance evidence.
  needs_reconciliation: ["ready", "applied"],
  failed: [],
  cancelled: [],
};

describe("validateCheckpointTransition", () => {
  it("accepts exactly the phases the lifecycle reaches from each phase", () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const verdict = validateCheckpointTransition({ from, to });
        expect(
          verdict.legal,
          `${from} -> ${to} should be ${
            EXPECTED_LEGAL[from].includes(to) ? "legal" : "illegal"
          }`,
        ).toBe(EXPECTED_LEGAL[from].includes(to));
      }
    }
  });

  it("refuses a transition from a phase to itself", () => {
    for (const phase of ALL_PHASES) {
      expect(
        validateCheckpointTransition({ from: phase, to: phase }).legal,
      ).toBe(false);
    }
  });

  it("names the refused edge in the reason so a refusal receipt can report it", () => {
    const verdict = validateCheckpointTransition({
      from: "ready",
      to: "applied",
    });
    expect(verdict.legal).toBe(false);
    if (verdict.legal) throw new Error("expected an illegal transition");
    expect(verdict.reason).toContain("ready");
    expect(verdict.reason).toContain("applied");
  });

  it("never lets a terminal phase move again", () => {
    for (const terminal of ["failed", "cancelled"] as const) {
      for (const to of ALL_PHASES) {
        expect(validateCheckpointTransition({ from: terminal, to }).legal).toBe(
          false,
        );
      }
    }
  });
});

/**
 * The edges a generic outcome may NOT walk, and the method that owns each. A
 * generic outcome carries no payload, no reference clear, no attempt binding
 * and no acceptance evidence, so these edges would move an operation to a phase
 * whose defining fact never happened.
 */
const EXPECTED_OWNERS: Readonly<
  Partial<Record<CheckpointPhase, Partial<Record<CheckpointPhase, string>>>>
> = {
  building: { retiring: "freezePayload" },
  retiring: { ready: "commitReady" },
  ready: { delivering: "beginDelivery" },
  delivering: { applied: "recordAcceptance" },
  needs_reconciliation: { applied: "recordAcceptance" },
};

describe("validateCheckpointOutcomeEdge", () => {
  it("refuses every legal edge whose meaning is evidence another method supplies", () => {
    for (const from of ALL_PHASES) {
      for (const to of ALL_PHASES) {
        const owner = EXPECTED_OWNERS[from]?.[to];
        const verdict = validateCheckpointOutcomeEdge({ from, to });
        expect(verdict.owned, `${from} -> ${to}`).toBe(owner === undefined);
        if (!verdict.owned) expect(verdict.owner).toBe(owner);
      }
    }
  });

  it("leaves the outcome-owned edges of the lifecycle available", () => {
    const outcomeEdges: [CheckpointPhase, CheckpointPhase][] = [
      ["building", "failed"],
      ["building", "cancelled"],
      ["retiring", "needs_reconciliation"],
      ["ready", "needs_reconciliation"],
      ["delivering", "ready"],
      ["delivering", "needs_reconciliation"],
      ["applied", "needs_reconciliation"],
      ["needs_reconciliation", "ready"],
    ];
    for (const [from, to] of outcomeEdges) {
      expect(
        validateCheckpointOutcomeEdge({ from, to }).owned,
        `${from} -> ${to}`,
      ).toBe(true);
      expect(validateCheckpointTransition({ from, to }).legal).toBe(true);
    }
  });

  it("names the owning method in the reason so a refusal receipt can report it", () => {
    const verdict = validateCheckpointOutcomeEdge({
      from: "retiring",
      to: "ready",
    });
    expect(verdict.owned).toBe(false);
    if (verdict.owned) throw new Error("expected an unowned edge");
    expect(verdict.reason).toContain("commitReady");
  });
});
