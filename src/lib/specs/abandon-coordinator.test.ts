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

function active(status: GraphWorkflowStatus): LinkedWorkflowObservation {
  return { kind: "active", workflowExecutionId: WORKFLOW_ID, status };
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
  ...graphWorkflowStatusSchema.options.map(active),
  ...graphWorkflowStatusSchema.options.map(archived),
];

describe("spec abandon cleanup phase vocabulary", () => {
  it("is exactly the three ordered phases the coordinator persists", () => {
    expect([...SPEC_EXECUTION_CLEANUP_PHASES]).toEqual([
      "abort_workflow",
      "release_slot",
      "finalize",
    ]);
    expect([...specExecutionCleanupPhaseSchema.options]).toEqual([
      ...SPEC_EXECUTION_CLEANUP_PHASES,
    ]);
    expect(INITIAL_ABANDON_CLEANUP_PHASE).toBe("abort_workflow");
  });
});

describe("nextAbandonCleanupStep — phase abort_workflow", () => {
  it("aborts a live linked workflow before anything else", () => {
    for (const status of ["pending", "running", "paused"] as const) {
      const step = nextAbandonCleanupStep({
        phase: "abort_workflow",
        linkedWorkflow: active(status),
      });
      expect(step).toEqual({
        act: { kind: "abort_workflow", workflowExecutionId: WORKFLOW_ID },
        nextPhase: "release_slot",
      });
    }
  });

  it("skips forward with an audit note when there is nothing to abort", () => {
    const cases: Array<{
      observation: LinkedWorkflowObservation;
      note: RegExp;
    }> = [
      { observation: NEVER_LAUNCHED, note: /ever launched/i },
      { observation: MISSING, note: /no longer exists/i },
      { observation: active("halted"), note: /already terminal/i },
      { observation: active("completed"), note: /already terminal/i },
      { observation: active("aborted"), note: /already terminal/i },
      { observation: archived("aborted"), note: /already archived/i },
    ];
    for (const { observation, note } of cases) {
      const step = nextAbandonCleanupStep({
        phase: "abort_workflow",
        linkedWorkflow: observation,
      });
      expect(step.nextPhase).toBe("release_slot");
      expect(step.act.kind).toBe("skip");
      if (step.act.kind !== "skip") throw new Error("unreachable");
      expect(step.act.note).toMatch(note);
    }
  });
});

describe("nextAbandonCleanupStep — phase release_slot", () => {
  it("releases a slot the lifecycle contract says is explicitly archivable", () => {
    for (const status of [
      "paused",
      "halted",
      "completed",
      "aborted",
    ] as const) {
      const step = nextAbandonCleanupStep({
        phase: "release_slot",
        linkedWorkflow: active(status),
      });
      expect(step).toEqual({
        act: { kind: "release_slot", workflowExecutionId: WORKFLOW_ID },
        nextPhase: "finalize",
      });
    }
  });

  it("refuses — never skips — while the run is live, and names the abort verb", () => {
    for (const status of ["pending", "running"] as const) {
      const step = nextAbandonCleanupStep({
        phase: "release_slot",
        linkedWorkflow: active(status),
      });
      expect(step.nextPhase).toBe("release_slot");
      expect(step.act.kind).toBe("blocked");
      if (step.act.kind !== "blocked") throw new Error("unreachable");
      expect(step.act.reason).toContain(WORKFLOW_ID);
      expect(step.act.remedy).toContain("cctl workflow live abort");
    }
  });

  it("skips forward with an audit note when no slot is owned", () => {
    const cases: Array<{
      observation: LinkedWorkflowObservation;
      note: RegExp;
    }> = [
      { observation: NEVER_LAUNCHED, note: /ever launched/i },
      { observation: MISSING, note: /no longer exists/i },
      { observation: archived("completed"), note: /already archived/i },
    ];
    for (const { observation, note } of cases) {
      const step = nextAbandonCleanupStep({
        phase: "release_slot",
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
  it("finalizes once nothing is linked, missing, or archived", () => {
    for (const observation of [
      NEVER_LAUNCHED,
      MISSING,
      archived("aborted"),
      archived("halted"),
    ]) {
      expect(
        nextAbandonCleanupStep({
          phase: "finalize",
          linkedWorkflow: observation,
        }),
      ).toEqual({ act: { kind: "finalize" }, nextPhase: null });
    }
  });

  it("refuses to finalize while the execution still holds the slot, naming the release verb", () => {
    for (const status of graphWorkflowStatusSchema.options) {
      const step = nextAbandonCleanupStep({
        phase: "finalize",
        linkedWorkflow: active(status),
      });
      expect(step.act.kind).toBe("blocked");
      if (step.act.kind !== "blocked") throw new Error("unreachable");
      expect(step.act.reason).toContain(WORKFLOW_ID);
      expect(step.act.remedy).toMatch(
        status === "pending" || status === "running"
          ? /cctl workflow live abort/
          : /cctl workflow live release/,
      );
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
