import { describe, expect, it } from "vitest";
import type { SourceRef } from "@/lib/conversations/schemas";
import type { CompactionEnvelope, Decision } from "./schemas";
import {
  validateCompactionGuards,
  type CompactionGuardContext,
} from "./guards";

function makeRef(overrides: Partial<SourceRef> = {}): SourceRef {
  return {
    messageIndex: 0,
    messageId: "m-0",
    seqStart: 0,
    seqEnd: 2,
    ...overrides,
  };
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    statement: "Use Zod schemas as the source of truth",
    status: "accepted",
    sourceRefs: [makeRef()],
    ...overrides,
  };
}

function makeEnvelope(
  overrides: Partial<CompactionEnvelope> = {},
): CompactionEnvelope {
  return {
    schemaVersion: 1,
    kind: "conversation_compaction",
    source: {
      projectName: "command-center",
      sessionName: "compaction",
      conversationId: "conv-1",
      coveredStartSeq: 0,
      coveredEndSeq: 12,
      messageCount: 4,
      sourceHash: "hash-1",
      ...overrides.source,
    },
    agentBrief: "brief",
    currentState: {
      status: "in-progress",
      latestUserGoal: "ship compaction",
      nextBestActions: ["implement guards"],
    },
    decisions: [],
    files: [],
    commands: [],
    openQuestions: [],
    blockers: [],
    omissions: { reasoningOmitted: true, largeToolOutputsElided: 0 },
    extras: {},
    ...overrides,
  };
}

const fullCtx: CompactionGuardContext = {
  mode: "full",
  expectedCoverage: { startSeq: 0, endSeq: 12 },
};

describe("validateCompactionGuards — coverage", () => {
  it("accepts an envelope whose coverage matches the expected range", () => {
    expect(validateCompactionGuards(makeEnvelope(), fullCtx)).toEqual({
      ok: true,
    });
  });

  it.each([
    [
      "start drifted",
      { coveredStartSeq: 1, coveredEndSeq: 12 },
      "coveredStartSeq",
    ],
    ["end short", { coveredStartSeq: 0, coveredEndSeq: 11 }, "coveredEndSeq"],
    [
      "end overshoots",
      { coveredStartSeq: 0, coveredEndSeq: 13 },
      "coveredEndSeq",
    ],
  ])("rejects when %s", (_name, coverage, expectedMention) => {
    const envelope = makeEnvelope({
      source: { ...makeEnvelope().source, ...coverage },
    });
    const result = validateCompactionGuards(envelope, fullCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join("\n")).toContain(expectedMention);
    }
  });
});

describe("validateCompactionGuards — sourceRefs bounds", () => {
  it.each([
    [
      "decisions",
      { decisions: [makeDecision({ sourceRefs: [makeRef({ seqEnd: 13 })] })] },
    ],
    [
      "files",
      {
        files: [
          {
            path: "src/a.ts",
            role: "modified" as const,
            sourceRefs: [makeRef({ seqStart: -1, seqEnd: 2 })],
          },
        ],
      },
    ],
    [
      "commands",
      {
        commands: [
          {
            command: "bun test",
            outcome: "succeeded" as const,
            sourceRefs: [makeRef({ seqStart: 20, seqEnd: 25 })],
          },
        ],
      },
    ],
    [
      "openQuestions",
      {
        openQuestions: [{ text: "q?", sourceRefs: [makeRef({ seqEnd: 99 })] }],
      },
    ],
    [
      "blockers",
      { blockers: [{ text: "b", sourceRefs: [makeRef({ seqEnd: 99 })] }] },
    ],
  ])("rejects an out-of-range ref in %s and names the array", (name, patch) => {
    const result = validateCompactionGuards(makeEnvelope(patch), fullCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join("\n")).toContain(name);
    }
  });

  it("rejects an inverted ref span (seqStart > seqEnd)", () => {
    const envelope = makeEnvelope({
      decisions: [
        makeDecision({ sourceRefs: [makeRef({ seqStart: 5, seqEnd: 3 })] }),
      ],
    });
    const result = validateCompactionGuards(envelope, fullCtx);
    expect(result.ok).toBe(false);
  });

  it("accepts refs exactly on the covered boundaries", () => {
    const envelope = makeEnvelope({
      decisions: [
        makeDecision({ sourceRefs: [makeRef({ seqStart: 0, seqEnd: 12 })] }),
      ],
    });
    expect(validateCompactionGuards(envelope, fullCtx)).toEqual({ ok: true });
  });

  it("accumulates one violation per bad ref", () => {
    const envelope = makeEnvelope({
      decisions: [makeDecision({ sourceRefs: [makeRef({ seqEnd: 99 })] })],
      blockers: [{ text: "b", sourceRefs: [makeRef({ seqEnd: 99 })] }],
    });
    const result = validateCompactionGuards(envelope, fullCtx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations).toHaveLength(2);
    }
  });
});

describe("validateCompactionGuards — delta continuity", () => {
  const previous = makeEnvelope({
    decisions: [
      makeDecision({ statement: "Keep me" }),
      makeDecision({ statement: "Already superseded", status: "superseded" }),
    ],
  });

  function deltaCtx(
    overrides: Partial<CompactionGuardContext> = {},
  ): CompactionGuardContext {
    return {
      mode: "delta",
      previousEnvelope: previous,
      expectedCoverage: { startSeq: 0, endSeq: 20 },
      ...overrides,
    };
  }

  function deltaEnvelope(
    overrides: Partial<CompactionEnvelope> = {},
  ): CompactionEnvelope {
    return makeEnvelope({
      source: { ...makeEnvelope().source, coveredEndSeq: 20 },
      decisions: [makeDecision({ statement: "Keep me" })],
      ...overrides,
    });
  }

  it("accepts a delta that extends coverage and keeps previous decisions", () => {
    expect(validateCompactionGuards(deltaEnvelope(), deltaCtx())).toEqual({
      ok: true,
    });
  });

  it("accepts dropping a decision that was already superseded", () => {
    const result = validateCompactionGuards(
      deltaEnvelope({ decisions: [makeDecision({ statement: "Keep me" })] }),
      deltaCtx(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("accepts a previous decision that the delta marks superseded", () => {
    const result = validateCompactionGuards(
      deltaEnvelope({
        decisions: [
          makeDecision({ statement: "Keep me", status: "superseded" }),
        ],
      }),
      deltaCtx(),
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects silently dropping a live previous decision", () => {
    const result = validateCompactionGuards(
      deltaEnvelope({ decisions: [] }),
      deltaCtx(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join("\n")).toContain("Keep me");
    }
  });

  it("rejects a delta whose coveredStartSeq differs from the previous envelope", () => {
    const envelope = deltaEnvelope({
      source: {
        ...makeEnvelope().source,
        coveredStartSeq: 5,
        coveredEndSeq: 20,
      },
    });
    const ctx = deltaCtx({ expectedCoverage: { startSeq: 5, endSeq: 20 } });
    const result = validateCompactionGuards(envelope, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join("\n")).toContain("coveredStartSeq");
    }
  });

  it("rejects a delta whose coverage regressed below the previous end", () => {
    const envelope = deltaEnvelope({
      source: { ...makeEnvelope().source, coveredEndSeq: 10 },
    });
    const ctx = deltaCtx({ expectedCoverage: { startSeq: 0, endSeq: 10 } });
    const result = validateCompactionGuards(envelope, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.join("\n")).toContain("monoton");
    }
  });

  it("rejects a delta run missing the previous envelope", () => {
    const result = validateCompactionGuards(
      deltaEnvelope(),
      deltaCtx({ previousEnvelope: undefined }),
    );
    expect(result.ok).toBe(false);
  });

  it("collects coverage and continuity violations together", () => {
    const envelope = deltaEnvelope({
      source: { ...makeEnvelope().source, coveredEndSeq: 19 },
      decisions: [],
    });
    const result = validateCompactionGuards(envelope, deltaCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    }
  });
});
