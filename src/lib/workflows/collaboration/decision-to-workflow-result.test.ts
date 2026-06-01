import { describe, expect, it } from "vitest";
import { decisionToWorkflowResult } from "./decision-to-workflow-result";
import type { CollaborationPolicyDecision } from "./policy";
import type { WorkflowCollaborationOpenConflict } from "@/lib/workflows/schemas";

const SAMPLE_CONFLICT: WorkflowCollaborationOpenConflict = {
  rejectingAgent: "agent_one",
  disputedPoint: "Use Postgres vs MySQL",
  severity: "blocking",
  category: "objective",
};

describe("decisionToWorkflowResult", () => {
  describe("happy path (mapping table coverage)", () => {
    it("maps final → converged with a non-empty finalAnswer", () => {
      const result = decisionToWorkflowResult({
        decision: { kind: "final" },
        finalAnswer: "Use Postgres.",
        openConflicts: [],
      });
      expect(result.status).toBe("converged");
      expect(result.finalAnswer).toBe("Use Postgres.");
      expect(result.openConflicts).toEqual([]);
    });

    it("maps ask_user.objective_disagreement → objective_disagreement with conflicts", () => {
      const result = decisionToWorkflowResult({
        decision: { kind: "ask_user", reason: "objective_disagreement" },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).toBe("objective_disagreement");
      expect(result.finalAnswer).toBeNull();
      expect(result.openConflicts).toEqual([SAMPLE_CONFLICT]);
    });

    it("maps ask_user.rounds_exhausted_above_threshold → rounds_exhausted with conflicts", () => {
      const result = decisionToWorkflowResult({
        decision: {
          kind: "ask_user",
          reason: "rounds_exhausted_above_threshold",
        },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).toBe("rounds_exhausted");
      expect(result.finalAnswer).toBeNull();
      expect(result.openConflicts).toEqual([SAMPLE_CONFLICT]);
    });

    it("maps ask_user.threshold_none_with_remaining → requires_user_input with conflicts", () => {
      const result = decisionToWorkflowResult({
        decision: {
          kind: "ask_user",
          reason: "threshold_none_with_remaining",
        },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).toBe("requires_user_input");
      expect(result.openConflicts).toEqual([SAMPLE_CONFLICT]);
    });

    it("maps ask_user.explicit_ask_user → requires_user_input with conflicts", () => {
      const result = decisionToWorkflowResult({
        decision: { kind: "ask_user", reason: "explicit_ask_user" },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).toBe("requires_user_input");
      expect(result.openConflicts).toEqual([SAMPLE_CONFLICT]);
    });

    it("maps fail → requires_user_input with conflicts (per research §10.1)", () => {
      const result = decisionToWorkflowResult({
        decision: { kind: "fail" },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).toBe("requires_user_input");
      expect(result.openConflicts).toEqual([SAMPLE_CONFLICT]);
    });
  });

  describe("table-driven cross-row coverage", () => {
    const ROWS: ReadonlyArray<{
      label: string;
      decision: CollaborationPolicyDecision;
      expected:
        | "converged"
        | "rounds_exhausted"
        | "requires_user_input"
        | "objective_disagreement";
    }> = [
      { label: "final", decision: { kind: "final" }, expected: "converged" },
      {
        label: "ask_user/objective",
        decision: { kind: "ask_user", reason: "objective_disagreement" },
        expected: "objective_disagreement",
      },
      {
        label: "ask_user/rounds_exhausted",
        decision: {
          kind: "ask_user",
          reason: "rounds_exhausted_above_threshold",
        },
        expected: "rounds_exhausted",
      },
      {
        label: "ask_user/threshold_none",
        decision: {
          kind: "ask_user",
          reason: "threshold_none_with_remaining",
        },
        expected: "requires_user_input",
      },
      {
        label: "ask_user/explicit",
        decision: { kind: "ask_user", reason: "explicit_ask_user" },
        expected: "requires_user_input",
      },
      {
        label: "fail",
        decision: { kind: "fail" },
        expected: "requires_user_input",
      },
    ];

    for (const row of ROWS) {
      it(`maps ${row.label} → ${row.expected}`, () => {
        const result = decisionToWorkflowResult({
          decision: row.decision,
          finalAnswer: row.decision.kind === "final" ? "Final." : null,
          openConflicts: row.decision.kind === "final" ? [] : [SAMPLE_CONFLICT],
        });
        expect(result.status).toBe(row.expected);
      });
    }

    it("regression: ask_user variants are never mis-mapped to converged", () => {
      const askUserReasons = [
        "objective_disagreement",
        "rounds_exhausted_above_threshold",
        "threshold_none_with_remaining",
        "explicit_ask_user",
      ] as const;
      for (const reason of askUserReasons) {
        const result = decisionToWorkflowResult({
          decision: { kind: "ask_user", reason },
          finalAnswer: null,
          openConflicts: [SAMPLE_CONFLICT],
        });
        expect(result.status).not.toBe("converged");
      }
    });

    it("regression: fail is never mis-mapped to converged", () => {
      const result = decisionToWorkflowResult({
        decision: { kind: "fail" },
        finalAnswer: null,
        openConflicts: [SAMPLE_CONFLICT],
      });
      expect(result.status).not.toBe("converged");
    });
  });

  describe("invariants", () => {
    it("throws when given continue_negotiation (non-terminal)", () => {
      expect(() =>
        decisionToWorkflowResult({
          decision: { kind: "continue_negotiation" },
          finalAnswer: null,
          openConflicts: [],
        }),
      ).toThrow(/continue_negotiation/);
    });

    it("throws on converged without a non-empty finalAnswer", () => {
      expect(() =>
        decisionToWorkflowResult({
          decision: { kind: "final" },
          finalAnswer: null,
          openConflicts: [],
        }),
      ).toThrow();
      expect(() =>
        decisionToWorkflowResult({
          decision: { kind: "final" },
          finalAnswer: "",
          openConflicts: [],
        }),
      ).toThrow();
    });

    it("throws on non-converged with no openConflicts (schema invariant)", () => {
      expect(() =>
        decisionToWorkflowResult({
          decision: { kind: "ask_user", reason: "explicit_ask_user" },
          finalAnswer: null,
          openConflicts: [],
        }),
      ).toThrow();
    });

    it("returns a result that round-trips through workflowCollaborationResultSchema", async () => {
      const { workflowCollaborationResultSchema } =
        await import("@/lib/workflows/schemas");
      const result = decisionToWorkflowResult({
        decision: { kind: "final" },
        finalAnswer: "Adopt Postgres.",
        openConflicts: [],
      });
      const parsed = workflowCollaborationResultSchema.parse(result);
      expect(parsed.status).toBe("converged");
      expect(parsed.finalAnswer).toBe("Adopt Postgres.");
    });
  });
});
