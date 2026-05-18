import { describe, expect, it } from "vitest";

import { agentCapabilityRuntimeApplicationStateSchema } from "@/lib/schemas";

import {
  computeCascadeRuntimeHash,
  recordApplyOutcome,
  sanitizeApplyError,
  seedRuntimeApplicationState,
} from "./runtime-hashes";

describe("computeCascadeRuntimeHash", () => {
  it("is deterministic across row order", () => {
    const a = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [
        { itemId: "alpha", enabled: true },
        { itemId: "beta", enabled: false },
      ],
    });
    const b = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [
        { itemId: "beta", enabled: false },
        { itemId: "alpha", enabled: true },
      ],
    });
    expect(a).toBe(b);
  });

  it("changes when an item's enabled value flips", () => {
    const a = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: true }],
    });
    const b = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    expect(a).not.toBe(b);
  });

  it("salts the hash with the cascade kind so coincident ids do not collide", () => {
    const a = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "x", enabled: true }],
    });
    const b = computeCascadeRuntimeHash({
      cascadeKind: "codex-skills",
      rows: [{ itemId: "x", enabled: true }],
    });
    expect(a).not.toBe(b);
  });

  it("empty rows produces a stable hash distinct from a one-row payload", () => {
    const empty = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [],
    });
    const oneRow = computeCascadeRuntimeHash({
      cascadeKind: "claude-skills",
      rows: [{ itemId: "alpha", enabled: false }],
    });
    expect(empty).not.toBe(oneRow);
    expect(empty).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("seedRuntimeApplicationState", () => {
  it("returns a schema-valid state with one record per seeded cascade", () => {
    const state = seedRuntimeApplicationState([
      {
        cascadeKind: "claude-skills",
        pendingHash: "abc",
        pendingItemIds: ["x", "y"],
        lastApplyStatus: "staged-next-turn",
      },
      {
        cascadeKind: "claude-plugins",
        pendingHash: "def",
        pendingItemIds: [],
        lastApplyStatus: "staged-next-turn",
      },
    ]);
    agentCapabilityRuntimeApplicationStateSchema.parse(state);
    expect(state.cascades["claude-skills"]?.pendingHash).toBe("abc");
    expect(state.cascades["claude-skills"]?.pendingItemIds).toEqual(["x", "y"]);
    expect(state.cascades["claude-plugins"]?.lastApplyStatus).toBe(
      "staged-next-turn",
    );
  });

  it("omits cascades the composer did not emit", () => {
    const state = seedRuntimeApplicationState([
      {
        cascadeKind: "claude-skills",
        pendingHash: "abc",
        pendingItemIds: [],
        lastApplyStatus: "staged-next-turn",
      },
    ]);
    expect(state.cascades["codex-skills"]).toBeUndefined();
    expect(state.cascades["claude-plugins"]).toBeUndefined();
  });
});

describe("recordApplyOutcome", () => {
  it("promotes pendingHash to appliedHash on success and clears pending", () => {
    const updated = recordApplyOutcome({
      previous: {
        appliedHash: "old",
        pendingHash: "new",
        pendingItemIds: ["alpha"],
        lastApplyStatus: "staged-next-turn",
      },
      attemptedHash: "new",
      attemptedItemIds: ["alpha"],
      outcome: { status: "applied" },
    });
    expect(updated.appliedHash).toBe("new");
    expect(updated.pendingHash).toBeUndefined();
    expect(updated.pendingItemIds).toBeUndefined();
    expect(updated.lastApplyStatus).toBe("applied");
    expect(updated.lastApplyError).toBeUndefined();
  });

  it("preserves the previous appliedHash on rejection", () => {
    const updated = recordApplyOutcome({
      previous: {
        appliedHash: "good",
        lastApplyStatus: "applied",
      },
      attemptedHash: "bad",
      attemptedItemIds: ["alpha", "beta"],
      outcome: { status: "rejected", error: "backend exploded" },
    });
    expect(updated.appliedHash).toBe("good");
    expect(updated.pendingHash).toBe("bad");
    expect(updated.pendingItemIds).toEqual(["alpha", "beta"]);
    expect(updated.lastApplyStatus).toBe("rejected");
    expect(updated.lastApplyError).toBe("backend exploded");
  });

  it("keeps pending state and status on staged outcomes without losing previous applied hash", () => {
    const updated = recordApplyOutcome({
      previous: {
        appliedHash: "v1",
        lastApplyStatus: "applied",
      },
      attemptedHash: "v2",
      attemptedItemIds: ["delta"],
      outcome: { status: "staged-idle" },
    });
    expect(updated.appliedHash).toBe("v1");
    expect(updated.pendingHash).toBe("v2");
    expect(updated.pendingItemIds).toEqual(["delta"]);
    expect(updated.lastApplyStatus).toBe("staged-idle");
    expect(updated.lastApplyError).toBeUndefined();
  });

  it("does not require a previous record (fresh conversation, first apply)", () => {
    const updated = recordApplyOutcome({
      previous: undefined,
      attemptedHash: "first",
      attemptedItemIds: [],
      outcome: { status: "applied" },
    });
    expect(updated.appliedHash).toBe("first");
    expect(updated.lastApplyStatus).toBe("applied");
  });
});

describe("sanitizeApplyError", () => {
  it("redacts POSIX home directories", () => {
    expect(
      sanitizeApplyError("ENOENT: /Users/alex/secret/file.json"),
    ).toContain("~");
    expect(sanitizeApplyError("error at /home/bob/.config/cc/x")).toContain(
      "~",
    );
    expect(sanitizeApplyError("/Users/alex/secret")).not.toContain("alex");
  });

  it("redacts long opaque tokens that look like secrets", () => {
    const token = "a".repeat(64);
    expect(sanitizeApplyError(`auth failed with ${token} present`)).toContain(
      "<redacted>",
    );
  });

  it("collapses whitespace so multi-line stack traces stay compact", () => {
    const raw = "line one\n   line two\n\n  line three";
    expect(sanitizeApplyError(raw)).toBe("line one line two line three");
  });

  it("caps very long messages with an ellipsis", () => {
    // Use a multi-word string so the token-redaction step does not collapse
    // the input to a single `<redacted>` placeholder before the length cap.
    const raw = "error frame ".repeat(200);
    const sanitized = sanitizeApplyError(raw);
    expect(sanitized.length).toBeLessThanOrEqual(500);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});
