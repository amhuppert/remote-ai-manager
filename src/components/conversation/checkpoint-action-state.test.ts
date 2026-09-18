import { pendingHandoff } from "@/lib/conversation-checkpoints/handoff-fixture";
import { checkpointHandoffEligibilityFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";
import { describe, expect, it } from "vitest";

import type { CheckpointRefusal } from "@/lib/conversation-checkpoints/admission";
import type { CheckpointEligibility } from "@/lib/conversation-checkpoints/queries";
import { checkpointReceiptFixture } from "@/lib/conversation-checkpoints/testing/receipt-fixture";

import {
  checkpointChipLabel,
  checkpointPhaseHeadline,
  deriveCheckpointActionState,
  deriveCheckpointChipState,
} from "./checkpoint-action-state";

function refusal(
  code: CheckpointRefusal["code"],
  overrides: Partial<CheckpointRefusal> = {},
): CheckpointRefusal {
  return {
    code,
    reason: `server said ${code}`,
    operationId: null,
    phase: null,
    ...overrides,
  };
}

function eligibility(
  overrides: Partial<CheckpointEligibility> = {},
): CheckpointEligibility {
  return {
    eligible: true,
    refusals: [],
    active: null,
    hosted: true,
    handoff: checkpointHandoffEligibilityFixture(),
    ...overrides,
  };
}

describe("deriveCheckpointChipState", () => {
  it("reads no checkpoint at all as the none state", () => {
    expect(deriveCheckpointChipState(null)).toEqual({ kind: "none" });
    expect(checkpointChipLabel({ kind: "none" })).toBe("No checkpoint");
  });

  it("distinguishes readiness from acceptance", () => {
    const ready = deriveCheckpointChipState(
      checkpointReceiptFixture({ phase: "ready" }),
    );
    const applied = deriveCheckpointChipState(
      checkpointReceiptFixture({ phase: "applied" }),
    );

    expect(ready).toEqual({ kind: "ready" });
    expect(applied).toEqual({ kind: "applied" });
    expect(checkpointPhaseHeadline(ready)).toBe(
      "Checkpoint ready — used by the next message",
    );
    expect(checkpointPhaseHeadline(applied)).toBe("Checkpoint applied");
  });

  it("carries the operator-facing failure message", () => {
    const state = deriveCheckpointChipState(
      checkpointReceiptFixture({
        phase: "failed",
        frozen: false,
        failure: { code: "generation_failed", message: "seed exceeded budget" },
      }),
    );

    expect(state).toEqual({
      kind: "failed",
      message: "seed exceeded budget",
    });
  });

  it("names the stage a reconciliation gate interrupted", () => {
    const state = deriveCheckpointChipState(
      checkpointReceiptFixture({
        phase: "needs_reconciliation",
        lastStablePhase: "delivering",
      }),
    );

    expect(state).toEqual({
      kind: "needs_reconciliation",
      lastStablePhase: "delivering",
    });
    expect(checkpointChipLabel(state)).toBe("Needs reconciliation");
  });

  it("reports the in-flight phases separately", () => {
    expect(
      deriveCheckpointChipState(
        checkpointReceiptFixture({ phase: "building" }),
      ),
    ).toEqual({ kind: "building" });
    expect(
      deriveCheckpointChipState(
        checkpointReceiptFixture({ phase: "retiring" }),
      ),
    ).toEqual({ kind: "retiring" });
    expect(
      deriveCheckpointChipState(
        checkpointReceiptFixture({ phase: "delivering" }),
      ),
    ).toEqual({ kind: "delivering" });
    expect(
      deriveCheckpointChipState(
        checkpointReceiptFixture({ phase: "cancelled", frozen: false }),
      ),
    ).toEqual({ kind: "cancelled" });
  });
});

describe("deriveCheckpointActionState", () => {
  it("is loading until eligibility has been read", () => {
    expect(
      deriveCheckpointActionState({ eligibility: undefined, isLoading: true }),
    ).toEqual({ kind: "loading" });
  });

  it("offers the action on an eligible ordinary conversation", () => {
    expect(deriveCheckpointActionState({ eligibility: eligibility() })).toEqual(
      {
        kind: "available",
      },
    );
  });

  it("gives a temporarily ineligible conversation a specific disabled reason", () => {
    const state = deriveCheckpointActionState({
      eligibility: eligibility({
        eligible: false,
        refusals: [refusal("turn_active")],
      }),
    });

    expect(state.kind).toBe("disabled");
    expect(state).toMatchObject({ code: "turn_active" });
    if (state.kind !== "disabled") throw new Error("expected disabled");
    expect(state.reason).toMatch(/turn/i);
  });

  it("offers no executable action for an owned or unsupported conversation", () => {
    for (const code of [
      "conversation_owned",
      "backend_unsupported",
      "conversation_archived",
      "conversation_transient",
      "no_recorded_history",
    ] as const) {
      const state = deriveCheckpointActionState({
        eligibility: eligibility({
          eligible: false,
          refusals: [refusal(code)],
        }),
      });
      expect(state.kind, code).toBe("unsupported");
    }
  });

  it("reports an operation already holding the slot as in progress", () => {
    const active = checkpointReceiptFixture({
      operationId: "op-3",
      phase: "building",
    });
    const state = deriveCheckpointActionState({
      eligibility: eligibility({
        eligible: false,
        refusals: [refusal("checkpoint_pending", { operationId: "op-3" })],
        active,
      }),
    });

    expect(state).toMatchObject({
      kind: "in_progress",
      operationId: "op-3",
      phase: "building",
    });
  });

  it("names the operation an explicit recovery must supersede", () => {
    const state = deriveCheckpointActionState({
      eligibility: eligibility({
        eligible: false,
        refusals: [refusal("recovery_required", { operationId: "op-9" })],
        active: checkpointReceiptFixture({
          operationId: "op-9",
          phase: "needs_reconciliation",
        }),
      }),
    });

    expect(state).toMatchObject({ kind: "recovery", operationId: "op-9" });
    if (state.kind !== "recovery") throw new Error("expected recovery");
    expect(state.reason).toMatch(/supersede/i);
  });

  it("routes uncertain queued delivery to queue review rather than a retry", () => {
    const state = deriveCheckpointActionState({
      eligibility: eligibility({
        eligible: false,
        refusals: [refusal("queue_review_required", { operationId: "op-9" })],
      }),
    });

    expect(state).toMatchObject({
      kind: "queue_review",
      operationId: "op-9",
    });
    if (state.kind !== "queue_review") throw new Error("expected queue_review");
    expect(state.reason).toMatch(/queued/i);
  });

  it("prefers a server refusal over a stale eligible cache", () => {
    const state = deriveCheckpointActionState({
      eligibility: eligibility(),
      serverRefusal: refusal("conversation_busy"),
    });

    expect(state).toMatchObject({
      kind: "disabled",
      code: "conversation_busy",
    });
  });

  it("takes the FIRST refusal as the primary one", () => {
    const state = deriveCheckpointActionState({
      eligibility: eligibility({
        eligible: false,
        refusals: [refusal("question_pending"), refusal("turn_active")],
      }),
    });

    expect(state).toMatchObject({
      kind: "disabled",
      code: "question_pending",
    });
  });
});

describe("capture progress", () => {
  it.each(["pending", "running", "settling"] as const)(
    "announces %s capture rather than generation",
    (stage) => {
      const state = deriveCheckpointChipState({
        ...checkpointReceiptFixture({ phase: "building" }),
        handoff: {
          ...pendingHandoff({
            stage,
            startedAt: stage === "pending" ? null : "2026-09-07T12:04:01.000Z",
            stopIntent: stage === "settling" ? "skip" : null,
          }),
          requested: true,
          categoryCounts: null,
          policy: null,
        },
      });
      expect(checkpointPhaseHeadline(state)).toBe(
        stage === "settling" ? "Stopping handoff…" : "Capturing agent handoff…",
      );
    },
  );
});
