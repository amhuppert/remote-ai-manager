import { describe, it, expect } from "vitest";

import {
  CHECKPOINT_SEED_BUDGET,
  truncateToUtf8Bytes,
  utf8ByteLength,
} from "./budget";

describe("CHECKPOINT_SEED_BUDGET", () => {
  it("carries the fixed product limits and partitions the total exactly", () => {
    expect(CHECKPOINT_SEED_BUDGET).toEqual({
      workingState: 18_432,
      recentDialogue: 10_240,
      recoveryFraming: 4_096,
      total: 32_768,
    });
    expect(
      CHECKPOINT_SEED_BUDGET.workingState +
        CHECKPOINT_SEED_BUDGET.recentDialogue +
        CHECKPOINT_SEED_BUDGET.recoveryFraming,
    ).toBe(CHECKPOINT_SEED_BUDGET.total);
  });
});

describe("utf8ByteLength", () => {
  it("measures bytes, not JavaScript string length", () => {
    expect(utf8ByteLength("abc")).toBe(3);
    // 2-byte, 3-byte, and 4-byte code points.
    expect(utf8ByteLength("é")).toBe(2);
    expect(utf8ByteLength("日")).toBe(3);
    expect(utf8ByteLength("🧭")).toBe(4);
    expect("🧭".length).toBe(2);
  });
});

describe("truncateToUtf8Bytes", () => {
  it("returns the input unchanged at an exact fit", () => {
    expect(truncateToUtf8Bytes("日本語", 9)).toBe("日本語");
  });

  it("drops the code point that would cross the limit by one byte", () => {
    expect(truncateToUtf8Bytes("日本語", 8)).toBe("日本");
    expect(utf8ByteLength(truncateToUtf8Bytes("日本語", 8))).toBe(6);
  });

  it("never splits a surrogate pair", () => {
    // Three 4-byte emoji; a 6-byte budget can only hold one whole one.
    const text = "🧭🧭🧭";
    const kept = truncateToUtf8Bytes(text, 6);
    expect(kept).toBe("🧭");
    expect(Array.from(kept)).toHaveLength(1);
    expect(kept).not.toContain("�");
    expect(Buffer.from(kept, "utf8").toString("utf8")).toBe(kept);
  });

  it("returns nothing when even the first code point does not fit", () => {
    expect(truncateToUtf8Bytes("🧭tail", 3)).toBe("");
    expect(truncateToUtf8Bytes("abc", 0)).toBe("");
    expect(truncateToUtf8Bytes("abc", -5)).toBe("");
  });
});

it("keeps capture-off allocation and all four ceilings when Unicode evidence fills the working budget", async () => {
  const { buildCheckpointSeed, CHECKPOINT_NOT_ESTABLISHED } =
    await import("./builder");
  const input = {
    identity: {
      conversationId: "c",
      checkpointId: "k",
      ordinal: 1,
      scope: "session" as const,
    },
    source: { firstSeq: 0, capturedThroughSeq: 0, totalMessages: 1 },
    entries: [
      {
        seq: 0,
        entryId: "e",
        role: "user" as const,
        timestamp: null,
        content: [{ type: "text" as const, text: "🧭".repeat(6000) }],
      },
    ],
    workingState: {
      objective: { text: CHECKPOINT_NOT_ESTABLISHED, sourceRefs: [] },
      latestRequest: { text: CHECKPOINT_NOT_ESTABLISHED, sourceRefs: [] },
      constraints: [
        {
          text: "é".repeat(8000),
          sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
        },
      ],
      outstandingRequests: [],
      decisions: [],
      failedApproaches: [],
      openQuestions: [],
      blockers: [],
      nextActions: [],
    },
  };
  const initial = buildCheckpointSeed(input);
  if (!initial.ok) throw new Error("initial evidence rejected");
  const constraint = input.workingState.constraints[0];
  if (!constraint) throw new Error("missing constraint");
  constraint.text += "x".repeat(18432 - initial.seed.sectionBytes.workingState);
  const baseline = buildCheckpointSeed(input);
  const included = buildCheckpointSeed({
    ...input,
    agentHandoff: {
      plan: [],
      hypotheses: [],
      failedApproaches: [],
      blockers: [],
      nextStep: [],
    },
  });
  if (!baseline.ok || !included.ok)
    throw new Error("bounded evidence rejected");
  expect(included.seed.handoffDecision).toBe("seed_budget");
  expect(included.seed.seedText).toBe(baseline.seed.seedText);
  expect(included.seed.seedSha256).toBe(baseline.seed.seedSha256);
  expect(included.seed.sectionBytes.workingState).toBe(18432);
  expect(included.seed.sectionBytes.recentDialogue).toBeLessThanOrEqual(10240);
  expect(included.seed.sectionBytes.recoveryFraming).toBeLessThanOrEqual(4096);
  expect(included.seed.sectionBytes.total).toBeLessThanOrEqual(32768);
  expect(included.seed.sectionBytes.total).toBe(
    Buffer.byteLength(included.seed.seedText),
  );
  expect(included.seed.seedText).not.toContain("�");
});
