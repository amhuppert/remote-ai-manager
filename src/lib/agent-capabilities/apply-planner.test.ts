import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyTimingForCascade,
  defaultAgentCapabilityMetadataRegistry,
} from "./metadata";
import {
  planCascadeApply,
  planCascadeFailure,
  planIdleDrainCascadeApply,
  planMissingTargetCascadeAfterMutation,
  planTurnStartCascadeApply,
  type PlanCascadeApplyInput,
} from "./apply-planner";

const baseInput = (
  overrides: Partial<PlanCascadeApplyInput>,
): PlanCascadeApplyInput => ({
  metadata: defaultAgentCapabilityMetadataRegistry.get("claude-skills"),
  applyTiming: "idle_live",
  previous: undefined,
  attemptedHash: "hash-attempt",
  attemptedItemIds: ["a", "b"],
  triggerMode: "idle",
  ...overrides,
});

describe("planCascadeApply", () => {
  it("returns staged-next-turn for next_turn timing regardless of turn state", () => {
    const plan = planCascadeApply(
      baseInput({
        metadata: defaultAgentCapabilityMetadataRegistry.get("codex-skills"),
        applyTiming: applyTimingForCascade("codex-skills"),
        triggerMode: "turn-active",
      }),
    );
    expect(plan.disposition).toBe("staged-next-turn");
  });

  it("treats matching hashes as applied no-ops even for next-turn cascades", () => {
    const plan = planCascadeApply(
      baseInput({
        metadata: defaultAgentCapabilityMetadataRegistry.get("codex-skills"),
        applyTiming: "next_turn",
        attemptedHash: "stable",
        previous: { appliedHash: "stable", lastApplyStatus: "applied" },
      }),
    );
    expect(plan.disposition).toBe("idempotent-no-op");
  });

  it("returns staged-next-turn for codex-plugins via the descriptor timing", () => {
    const plan = planCascadeApply(
      baseInput({
        metadata: defaultAgentCapabilityMetadataRegistry.get("codex-plugins"),
        applyTiming: applyTimingForCascade("codex-plugins"),
      }),
    );
    expect(plan.disposition).toBe("staged-next-turn");
  });

  it("returns idempotent-no-op when attempted hash matches applied hash", () => {
    const plan = planCascadeApply(
      baseInput({
        attemptedHash: "stable",
        previous: { appliedHash: "stable", lastApplyStatus: "applied" },
      }),
    );
    expect(plan.disposition).toBe("idempotent-no-op");
  });

  it("does not short-circuit when applied hash matches but last status was rejected", () => {
    const plan = planCascadeApply(
      baseInput({
        attemptedHash: "stable",
        previous: {
          appliedHash: "stable",
          lastApplyStatus: "rejected",
          lastApplyError: "boom",
        },
      }),
    );
    expect(plan.disposition).toBe("try-live-apply");
  });

  it("returns staged-idle for idle_live timing while a turn is active", () => {
    const plan = planCascadeApply(baseInput({ triggerMode: "turn-active" }));
    expect(plan.disposition).toBe("staged-idle");
  });

  it("returns try-live-apply for idle_live timing when idle", () => {
    const plan = planCascadeApply(baseInput({ triggerMode: "idle" }));
    expect(plan.disposition).toBe("try-live-apply");
  });

  it("returns deferred-next-conversation for next_conversation timing (claude-agents)", () => {
    const plan = planCascadeApply(
      baseInput({
        metadata: defaultAgentCapabilityMetadataRegistry.get("claude-agents"),
        applyTiming: applyTimingForCascade("claude-agents"),
        triggerMode: "idle",
      }),
    );
    expect(plan.disposition).toBe("deferred-next-conversation");
  });
});

describe("planIdleDrainCascadeApply", () => {
  it("drains staged-idle pending work when the composed hash still matches", () => {
    const plan = planIdleDrainCascadeApply({
      previous: {
        pendingHash: "hash-a",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "staged-idle",
      },
      composed: {
        attemptedHash: "hash-a",
        attemptedItemIds: ["alpha"],
      },
    });
    expect(plan).toEqual({
      disposition: "try-live-apply",
      attemptedHash: "hash-a",
      attemptedItemIds: ["alpha"],
    });
  });

  it("retries rejected pending work on the next idle drain", () => {
    const plan = planIdleDrainCascadeApply({
      previous: {
        appliedHash: "hash-applied",
        pendingHash: "hash-pending",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "rejected",
        lastApplyError: "transient failure",
      },
      composed: {
        attemptedHash: "hash-pending",
        attemptedItemIds: ["alpha"],
      },
    });
    expect(plan.disposition).toBe("try-live-apply");
  });

  it("clears obsolete staged-idle work when the composer no longer emits the cascade", () => {
    const plan = planIdleDrainCascadeApply({
      previous: {
        pendingHash: "hash-obsolete",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "staged-idle",
      },
      composed: undefined,
    });
    expect(plan).toEqual({
      disposition: "idempotent-no-op",
      stateAction: "clear-obsolete",
      reason: "missing-composed-cascade",
    });
  });

  it("preserves pending work without applying when the composed hash drifted", () => {
    const plan = planIdleDrainCascadeApply({
      previous: {
        pendingHash: "hash-staged",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "staged-idle",
      },
      composed: {
        attemptedHash: "hash-drifted",
        attemptedItemIds: ["beta"],
      },
    });
    expect(plan).toEqual({
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "hash-drift",
    });
  });
});

describe("planTurnStartCascadeApply", () => {
  it("promotes non-next-turn staged work when the composed hash still matches", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: "idle_live",
      previous: {
        pendingHash: "hash-a",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "staged-next-turn",
      },
      composed: {
        attemptedHash: "hash-a",
        attemptedItemIds: ["alpha"],
      },
    });
    expect(plan).toEqual({
      disposition: "applied",
      attemptedHash: "hash-a",
      attemptedItemIds: ["alpha"],
    });
  });

  it("sends next_turn staged work through runtime delivery", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: applyTimingForCascade("codex-skills"),
      previous: {
        pendingHash: "hash-a",
        pendingItemIds: ["spec-init"],
        lastApplyStatus: "staged-next-turn",
      },
      composed: {
        attemptedHash: "hash-a",
        attemptedItemIds: ["spec-init"],
      },
    });
    expect(plan).toEqual({
      disposition: "try-turn-start-apply",
      attemptedHash: "hash-a",
      attemptedItemIds: ["spec-init"],
    });
  });

  it("retries rejected next_turn pending work at turn start", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: "next_turn",
      previous: {
        appliedHash: "hash-applied",
        pendingHash: "hash-pending",
        pendingItemIds: ["spec-init"],
        lastApplyStatus: "rejected",
        lastApplyError: "transient failure",
      },
      composed: {
        attemptedHash: "hash-pending",
        attemptedItemIds: ["spec-init"],
      },
    });
    expect(plan.disposition).toBe("try-turn-start-apply");
  });

  it("preserves deferred-next-conversation work at turn start", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: "next_conversation",
      previous: {
        pendingHash: "hash-agent",
        pendingItemIds: ["doc-writer"],
        lastApplyStatus: "deferred-next-conversation",
      },
      composed: {
        attemptedHash: "hash-agent",
        attemptedItemIds: ["doc-writer"],
      },
    });
    expect(plan).toEqual({
      disposition: "deferred-next-conversation",
      stateAction: "preserve",
    });
  });

  it("does not retry rejected idle_live pending work at turn start", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: applyTimingForCascade("claude-skills"),
      previous: {
        pendingHash: "hash-pending",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "rejected",
      },
      composed: {
        attemptedHash: "hash-pending",
        attemptedItemIds: ["alpha"],
      },
    });
    expect(plan).toEqual({
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "not-turn-start-pending",
    });
  });

  it("preserves pending work without applying when turn-start hash drifted", () => {
    const plan = planTurnStartCascadeApply({
      applyTiming: "next_turn",
      previous: {
        pendingHash: "hash-staged",
        pendingItemIds: ["spec-init"],
        lastApplyStatus: "staged-next-turn",
      },
      composed: {
        attemptedHash: "hash-drifted",
        attemptedItemIds: ["other-skill"],
      },
    });
    expect(plan).toEqual({
      disposition: "idempotent-no-op",
      stateAction: "preserve",
      reason: "hash-drift",
    });
  });
});

describe("planMissingTargetCascadeAfterMutation", () => {
  it("rejects translator-backed targets that disappeared after mutation composition", () => {
    const plan = planMissingTargetCascadeAfterMutation({
      metadata: defaultAgentCapabilityMetadataRegistry.get("claude-skills"),
      previous: {
        appliedHash: "hash-applied",
        lastApplyStatus: "applied",
      },
    });
    expect(plan).toEqual({
      disposition: "rejected",
      attemptedHash: "hash-applied",
      attemptedItemIds: [],
      reason: "missing-target-cascade",
    });
  });
});

describe("planCascadeFailure", () => {
  it("rejects translator-backed failed discovery with retryable pending state", () => {
    const plan = planCascadeFailure({
      metadata: defaultAgentCapabilityMetadataRegistry.get("claude-skills"),
      previous: {
        appliedHash: "hash-applied",
        lastApplyStatus: "applied",
      },
      failureKind: "failed-discovery",
    });
    expect(plan).toEqual({
      disposition: "rejected",
      attemptedHash: "hash-applied",
      attemptedItemIds: [],
      reason: "failed-discovery",
    });
  });
});

describe("architecture: neutral planner", () => {
  it("contains zero backend-identity branches", () => {
    const source = readFileSync(
      path.join(__dirname, "apply-planner.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/backend\s*===/);
    expect(source).not.toMatch(/applySemantics/);
  });
});
