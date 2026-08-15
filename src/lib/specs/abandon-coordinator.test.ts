import { describe, expect, it } from "vitest";
import { graphWorkflowStatusSchema } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowStatus } from "@/lib/workflow-graph/definition-schemas";
import { specExecutionCleanupPhaseSchema } from "./schemas";
import type { SpecExecutionCleanupPhase } from "./schemas";
import {
  INITIAL_ABANDON_CLEANUP_PHASE,
  SPEC_EXECUTION_CLEANUP_PHASES,
  abandonFinalizationAllowed,
  nextAbandonCleanupStep,
} from "./abandon-coordinator";
import type { LinkedWorkflowObservation } from "./abandon-coordinator";

const WORKFLOW_ID = "wf-exec-1";

/**
 * The default is lease-HELD because that is the only observation with an act
 * behind it: a lease-free record in the active row is History already.
 */
function active(
  status: GraphWorkflowStatus,
  leaseHeld = true,
): LinkedWorkflowObservation {
  return {
    kind: "active",
    workflowExecutionId: WORKFLOW_ID,
    status,
    leaseHeld,
  };
}

function archived(status: GraphWorkflowStatus): LinkedWorkflowObservation {
  return { kind: "archived", workflowExecutionId: WORKFLOW_ID, status };
}

const MISSING: LinkedWorkflowObservation = {
  kind: "missing",
  workflowExecutionId: WORKFLOW_ID,
};
const NEVER_LAUNCHED: LinkedWorkflowObservation = { kind: "never_launched" };

const ALL_OBSERVATIONS: LinkedWorkflowObservation[] = [
  NEVER_LAUNCHED,
  MISSING,
  // Both tenures per status: the invariants below must hold whether or not the
  // record in the active row still holds the lease.
  ...graphWorkflowStatusSchema.options.map((status) => active(status, true)),
  ...graphWorkflowStatusSchema.options.map((status) => active(status, false)),
  ...graphWorkflowStatusSchema.options.map((status) => archived(status)),
];

describe("spec abandon cleanup phase vocabulary", () => {
  it("is exactly the two ordered phases the coordinator persists", () => {
    // `release_slot` is gone with the act it called: `aborted` releases the
    // lease on its own, so the phase had nothing left to do and no verb to do
    // it with.
    expect([...SPEC_EXECUTION_CLEANUP_PHASES]).toEqual([
      "abort_workflow",
      "finalize",
    ]);
    expect([...SPEC_EXECUTION_CLEANUP_PHASES]).not.toContain("release_slot");
    expect([...specExecutionCleanupPhaseSchema.options]).toEqual([
      ...SPEC_EXECUTION_CLEANUP_PHASES,
    ]);
    expect(INITIAL_ABANDON_CLEANUP_PHASE).toBe("abort_workflow");
  });
});

describe("nextAbandonCleanupStep — phase abort_workflow", () => {
  it("aborts a lease-holding linked workflow that has not halted", () => {
    for (const status of ["pending", "running", "paused"] as const) {
      const step = nextAbandonCleanupStep({
        phase: "abort_workflow",
        linkedWorkflow: active(status),
      });
      expect(step).toEqual({
        act: { kind: "abort_workflow", workflowExecutionId: WORKFLOW_ID },
        nextPhase: "finalize",
      });
    }
  });

  it("abandons a lease-holding halt instead of aborting it", () => {
    // A halt that still holds the lease is by definition resumable, and R4
    // makes abandon the ONE act that ends that tenure. Aborting it would drive
    // the run to `aborted`, discarding the halt reason the audited abandon
    // preserves — the same act the finalize refusal already names as the
    // remedy, so cleanup must not reach for a different one.
    const step = nextAbandonCleanupStep({
      phase: "abort_workflow",
      linkedWorkflow: active("halted"),
    });

    expect(step).toEqual({
      act: { kind: "abandon_workflow", workflowExecutionId: WORKFLOW_ID },
      nextPhase: "finalize",
    });
  });

  it("skips forward with an audit note when there is nothing to abort", () => {
    const cases: Array<{
      observation: LinkedWorkflowObservation;
      note: RegExp;
    }> = [
      { observation: NEVER_LAUNCHED, note: /ever launched/i },
      { observation: MISSING, note: /no longer exists/i },
      { observation: active("halted", false), note: /no longer holds/i },
      { observation: active("completed", false), note: /no longer holds/i },
      { observation: active("aborted", false), note: /no longer holds/i },
      { observation: archived("aborted"), note: /already archived/i },
    ];
    for (const { observation, note } of cases) {
      const step = nextAbandonCleanupStep({
        phase: "abort_workflow",
        linkedWorkflow: observation,
      });
      expect(step.nextPhase).toBe("finalize");
      expect(step.act.kind).toBe("skip");
      if (step.act.kind !== "skip") throw new Error("unreachable");
      expect(step.act.note).toMatch(note);
    }
  });
});

describe("nextAbandonCleanupStep — phase finalize", () => {
  it("finalizes once nothing holds the lease", () => {
    for (const observation of [
      NEVER_LAUNCHED,
      MISSING,
      archived("aborted"),
      archived("halted"),
      // Terminal but not yet normalized out of the active row: History owns it
      // and the next launch relocates it, so it blocks nothing.
      active("aborted", false),
    ]) {
      expect(
        nextAbandonCleanupStep({
          phase: "finalize",
          linkedWorkflow: observation,
        }),
      ).toEqual({ act: { kind: "finalize" }, nextPhase: null });
    }
  });

  it("refuses to finalize while the execution still holds the lease, naming the act that ends it", () => {
    for (const status of graphWorkflowStatusSchema.options) {
      const step = nextAbandonCleanupStep({
        phase: "finalize",
        linkedWorkflow: active(status),
      });
      expect(step.act.kind).toBe("blocked");
      if (step.act.kind !== "blocked") throw new Error("unreachable");
      expect(step.act.reason).toContain(WORKFLOW_ID);
      // A halted lease holder is ended by abandon, which preserves the halt
      // reason; everything else by abort, which releases on its own. Neither
      // remedy names a release verb, because none exists.
      expect(step.act.remedy).toMatch(
        status === "halted"
          ? /cctl workflow abandon/
          : /cctl workflow live abort/,
      );
      expect(step.act.remedy).not.toContain("live release");
      expect(step.nextPhase).toBe("finalize");
    }
  });
});

describe("abandon state-machine invariants", () => {
  it("never emits finalize from a phase other than finalize", () => {
    for (const phase of SPEC_EXECUTION_CLEANUP_PHASES) {
      for (const observation of ALL_OBSERVATIONS) {
        const step = nextAbandonCleanupStep({
          phase,
          linkedWorkflow: observation,
        });
        if (step.act.kind === "finalize") expect(phase).toBe("finalize");
      }
    }
    for (const phase of SPEC_EXECUTION_CLEANUP_PHASES) {
      expect(abandonFinalizationAllowed(phase)).toBe(phase === "finalize");
    }
  });

  it("only ever advances the phase in the declared order, never backwards", () => {
    const order: SpecExecutionCleanupPhase[] = [
      ...SPEC_EXECUTION_CLEANUP_PHASES,
    ];
    for (const phase of order) {
      for (const observation of ALL_OBSERVATIONS) {
        const { nextPhase } = nextAbandonCleanupStep({
          phase,
          linkedWorkflow: observation,
        });
        if (nextPhase === null) continue;
        expect(order.indexOf(nextPhase)).toBeGreaterThanOrEqual(
          order.indexOf(phase),
        );
      }
    }
  });

  it("makes progress or blocks — a non-blocked step always leaves the phase", () => {
    for (const phase of SPEC_EXECUTION_CLEANUP_PHASES) {
      for (const observation of ALL_OBSERVATIONS) {
        const step = nextAbandonCleanupStep({
          phase,
          linkedWorkflow: observation,
        });
        if (step.act.kind === "blocked") {
          expect(step.nextPhase).toBe(phase);
          continue;
        }
        expect(step.nextPhase).not.toBe(phase);
      }
    }
  });
});
