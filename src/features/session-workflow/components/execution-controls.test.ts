import { describe, expect, it } from "vitest";
import type {
  GraphWorkflowAbandonment,
  GraphWorkflowHaltReason,
} from "@/lib/workflow-graph/schemas";
import {
  resolveExecutionControls,
  type ExecutionControlInput,
} from "./execution-controls";

const resumableHalt: GraphWorkflowHaltReason = {
  type: "agent_turn_failed",
  contextId: "context-plan",
  engine: "claude",
  cause: "sdk_error",
  message: "SDK stream ended unexpectedly",
};

const nonResumableHalt: GraphWorkflowHaltReason = {
  type: "recovery_error",
  message: "Recovery failed",
};

const abandonment: GraphWorkflowAbandonment = {
  abandonedAt: "2026-08-20T10:00:00.000Z",
  reason: "Operator abandoned the run.",
  actor: { kind: "human" },
};

function input(
  overrides: Partial<ExecutionControlInput> = {},
): ExecutionControlInput {
  return {
    status: "running",
    haltReason: null,
    abandonment: null,
    definitionApproval: null,
    allowActions: true,
    canAbandon: true,
    canDecideDefinition: true,
    resumeBlockedReason: null,
    repairInFlight: false,
    ...overrides,
  };
}

function kinds(overrides: Partial<ExecutionControlInput> = {}): string[] {
  return resolveExecutionControls(input(overrides)).map(
    (control) => control.kind,
  );
}

describe("resolveExecutionControls — README §9 state and action matrix", () => {
  it("offers only Abort while pending", () => {
    expect(kinds({ status: "pending" })).toEqual(["abort"]);
  });

  it("offers the definition decision — and nothing else — while awaiting definition approval", () => {
    expect(
      kinds({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-20T09:00:00.000Z",
          approvedAt: null,
        },
      }),
    ).toEqual(["approve-definition", "reject-definition"]);
  });

  it("treats an already-approved definition as an ordinary pending run", () => {
    expect(
      kinds({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-20T09:00:00.000Z",
          approvedAt: "2026-08-20T09:05:00.000Z",
        },
      }),
    ).toEqual(["abort"]);
  });

  it("offers Pause and Abort while running", () => {
    expect(kinds({ status: "running" })).toEqual(["pause", "abort"]);
  });

  it("offers Resume and Abort while paused", () => {
    expect(kinds({ status: "paused" })).toEqual(["resume", "abort"]);
  });

  it("offers Resume and Abandon for a resumable halt that still holds the lease", () => {
    expect(kinds({ status: "halted", haltReason: resumableHalt })).toEqual([
      "resume",
      "abandon",
    ]);
  });

  // A halt whose only repair is an edit the operator has not made yet: resuming
  // reproduces the same refusal and spends another turn, so the control is
  // offered in its blocked form rather than withdrawn (a missing button reads
  // as "this run is over") and rather than enabled (a lie the card contradicts).
  describe("a resume blocked by an unrepaired contract", () => {
    const blocked = {
      status: "halted" as const,
      haltReason: resumableHalt,
      resumeBlockedReason: "blocked until the contract is accepted",
    };

    it("keeps Resume in the matrix but marks it blocked", () => {
      expect(kinds(blocked)).toEqual(["resume", "abandon"]);
      const resume = resolveExecutionControls(input(blocked)).find(
        (control) => control.kind === "resume",
      );
      expect(resume?.blockedReason).toBe(
        "blocked until the contract is accepted",
      );
      expect(resume?.idleLabel).toBe(
        "Resume — blocked until the contract is accepted",
      );
    });

    it("leaves Abandon usable, which is the other way out", () => {
      const abandon = resolveExecutionControls(input(blocked)).find(
        (control) => control.kind === "abandon",
      );
      expect(abandon?.blockedReason).toBeNull();
    });

    it("does not block a pause-initiated resume, which has no contract to repair", () => {
      const resume = resolveExecutionControls(
        input({ status: "paused", resumeBlockedReason: null }),
      ).find((control) => control.kind === "resume");
      expect(resume?.blockedReason).toBeNull();
      expect(resume?.idleLabel).toBe("Resume");
    });
  });

  it("offers nothing for a non-resumable halt", () => {
    expect(kinds({ status: "halted", haltReason: nonResumableHalt })).toEqual(
      [],
    );
  });

  it("offers nothing for an abandoned halt, which released its lease", () => {
    expect(
      kinds({ status: "halted", haltReason: resumableHalt, abandonment }),
    ).toEqual([]);
  });

  it("offers nothing once completed or aborted", () => {
    expect(kinds({ status: "completed" })).toEqual([]);
    expect(kinds({ status: "aborted" })).toEqual([]);
  });

  it("offers nothing for a historical selection, whatever its status was", () => {
    expect(kinds({ status: "running", allowActions: false })).toEqual([]);
    expect(
      kinds({
        status: "halted",
        haltReason: resumableHalt,
        allowActions: false,
      }),
    ).toEqual([]);
  });

  it("omits the definition decision when the page did not wire its mutations", () => {
    expect(
      kinds({
        status: "pending",
        canDecideDefinition: false,
        definitionApproval: {
          requestedAt: "2026-08-20T09:00:00.000Z",
          approvedAt: null,
        },
      }),
    ).toEqual([]);
  });

  it("omits Abandon when the page did not wire the abandon mutation", () => {
    expect(
      kinds({
        status: "halted",
        haltReason: resumableHalt,
        canAbandon: false,
      }),
    ).toEqual(["resume"]);
  });
});

describe("resolveExecutionControls — labels and confirmation", () => {
  it("gives every control an idle and a pending label", () => {
    const labels = new Map(
      [
        ...resolveExecutionControls(input({ status: "running" })),
        ...resolveExecutionControls(input({ status: "paused" })),
        ...resolveExecutionControls(
          input({ status: "halted", haltReason: resumableHalt }),
        ),
      ].map((control) => [
        control.kind,
        [control.idleLabel, control.pendingLabel],
      ]),
    );

    expect(labels.get("pause")).toEqual(["Pause", "Pausing…"]);
    expect(labels.get("resume")).toEqual(["Resume", "Resuming…"]);
    expect(labels.get("abort")).toEqual(["Abort", "Aborting…"]);
    expect(labels.get("abandon")).toEqual(["Abandon", "Abandoning…"]);
  });

  it("confirms before abandoning, with the design's copy", () => {
    const abandon = resolveExecutionControls(
      input({ status: "halted", haltReason: resumableHalt }),
    ).find((control) => control.kind === "abandon");

    expect(abandon?.confirm).toEqual({
      title: "Abandon halted execution?",
      message:
        "End this resumably halted execution's lease and move it to History.",
      confirmLabel: "Abandon execution",
    });
  });

  it("confirms before aborting", () => {
    const abort = resolveExecutionControls(input({ status: "running" })).find(
      (control) => control.kind === "abort",
    );

    expect(abort?.confirm?.confirmLabel).toBe("Abort execution");
    expect(abort?.confirm?.message).toContain("History");
  });

  it("confirms before rejecting a definition and keeps approve unconfirmed", () => {
    const controls = resolveExecutionControls(
      input({
        status: "pending",
        definitionApproval: {
          requestedAt: "2026-08-20T09:00:00.000Z",
          approvedAt: null,
        },
      }),
    );

    const approve = controls.find(
      (control) => control.kind === "approve-definition",
    );
    const reject = controls.find(
      (control) => control.kind === "reject-definition",
    );

    expect(approve?.confirm).toBeNull();
    expect(approve?.idleLabel).toBe("Approve");
    expect(approve?.pendingLabel).toBe("Approving…");
    expect(reject?.idleLabel).toBe("Reject");
    expect(reject?.pendingLabel).toBe("Rejecting…");
    expect(reject?.confirm).toEqual({
      title: "Reject workflow definition?",
      message:
        "Reject this parked definition and move the execution to History.",
      confirmLabel: "Reject definition",
    });
  });

  it("does not confirm a non-destructive control", () => {
    const pause = resolveExecutionControls(input({ status: "running" })).find(
      (control) => control.kind === "pause",
    );

    expect(pause?.confirm).toBeNull();
  });
});

describe("resolveExecutionControls — a resume that would cut a repair short", () => {
  it("asks first when a repair agent's round is open on the halt", () => {
    const resume = resolveExecutionControls(
      input({
        status: "halted",
        haltReason: resumableHalt,
        repairInFlight: true,
      }),
    ).find((control) => control.kind === "resume");

    // Not blocked — the operator may always take the run back. Confirmed,
    // because the halt reads the same whether or not an agent is on it, and
    // resuming withdraws that round with its diagnosis unwritten.
    expect(resume?.blockedReason).toBeNull();
    expect(resume?.confirm?.message).toMatch(/repair agent/i);
  });

  it("keeps Resume immediate when nothing is working the halt", () => {
    const resume = resolveExecutionControls(
      input({ status: "halted", haltReason: resumableHalt }),
    ).find((control) => control.kind === "resume");

    expect(resume?.confirm).toBeNull();
  });

  it("still withholds a blocked resume while a repair round is open", () => {
    const resume = resolveExecutionControls(
      input({
        status: "halted",
        haltReason: resumableHalt,
        repairInFlight: true,
        resumeBlockedReason: "blocked until the contract is accepted",
      }),
    ).find((control) => control.kind === "resume");

    expect(resume?.blockedReason).toBe(
      "blocked until the contract is accepted",
    );
  });
});
