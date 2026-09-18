import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";

import {
  buildCheckpointSeed,
  CHECKPOINT_NOT_ESTABLISHED,
  checkpointWorkingStateSchema,
  type BuildCheckpointSeedInput,
  type CheckpointWorkingState,
} from "./builder";
import { CHECKPOINT_SEED_BUDGET, utf8ByteLength } from "./budget";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import { groupTranscriptEntries } from "@/lib/conversations/transcript-render";

function entry(
  seq: number,
  role: "user" | "assistant",
  content: MessageContentBlock[],
): TranscriptEntryWithSeq {
  return {
    seq,
    entryId: `entry-${seq}`,
    role,
    timestamp: "2026-01-01T00:00:00Z",
    content,
  };
}

function text(
  seq: number,
  role: "user" | "assistant",
  body: string,
): TranscriptEntryWithSeq {
  return entry(seq, role, [{ type: "text", text: body }]);
}

const ENTRIES: TranscriptEntryWithSeq[] = [
  text(0, "user", "build the checkpoint seed"),
  text(1, "assistant", "starting with the budget module"),
  text(2, "user", "keep the archive recoverable"),
  text(3, "assistant", "captured through the raw boundary"),
];

function workingState(
  overrides: Partial<CheckpointWorkingState> = {},
): CheckpointWorkingState {
  return checkpointWorkingStateSchema.parse({
    objective: {
      text: "deliver the bounded checkpoint seed",
      sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
    },
    latestRequest: {
      text: "keep the archive recoverable",
      sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
    },
    outstandingRequests: [
      {
        text: "keep original evidence recoverable",
        sourceRefs: [{ messageIndex: 2, seqStart: 2, seqEnd: 2 }],
      },
    ],
    constraints: [
      {
        text: "the injected seed is at most 32768 bytes",
        sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
      },
    ],
    decisions: [
      {
        statement: "generate from the original archive, not the last summary",
        status: "accepted",
        rationale: "a summary chain compounds loss",
        sourceRefs: [{ messageIndex: 1, seqStart: 1, seqEnd: 1 }],
      },
      {
        statement: "carry the previous checkpoint as the sole source",
        status: "rejected",
        rationale: "drops evidence omitted earlier",
        sourceRefs: [{ messageIndex: 1, seqStart: 1, seqEnd: 1 }],
      },
    ],
    failedApproaches: [
      {
        approach: "byte-to-token conversion for the budget",
        outcome: "rejected: the limit must be exact UTF-8 bytes",
        sourceRefs: [{ messageIndex: 1, seqStart: 1, seqEnd: 1 }],
      },
    ],
    openQuestions: [
      {
        text: "which backends prove real continuation",
        sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
      },
    ],
    blockers: [],
    nextActions: [
      {
        text: "freeze the rendered bytes and hash them",
        sourceRefs: [{ messageIndex: 3, seqStart: 3, seqEnd: 3 }],
      },
    ],
    ...overrides,
  });
}

function makeInput(
  overrides: Partial<BuildCheckpointSeedInput> = {},
): BuildCheckpointSeedInput {
  const entries = overrides.entries ?? ENTRIES;
  return {
    identity: {
      conversationId: "convo-1",
      checkpointId: "ckpt-1",
      ordinal: 1,
      scope: "session",
    },
    source: {
      firstSeq: entries[0]?.seq ?? 0,
      capturedThroughSeq: entries[entries.length - 1]?.seq ?? 0,
      totalMessages: groupTranscriptEntries(entries).length,
    },
    workingState: workingState(),
    entries,
    ...overrides,
  };
}

function built(input = makeInput()) {
  const result = buildCheckpointSeed(input);
  if (!result.ok) {
    throw new Error(
      `expected a built seed, got issues: ${JSON.stringify(result.issues)}`,
    );
  }
  return result.seed;
}

describe("buildCheckpointSeed — frozen bytes and budgets", () => {
  it("hashes the exact rendered bytes and reports section sizes that sum to the total", () => {
    const seed = built();

    expect(seed.sectionBytes.total).toBe(utf8ByteLength(seed.seedText));
    expect(
      seed.sectionBytes.workingState +
        seed.sectionBytes.recentDialogue +
        seed.sectionBytes.recoveryFraming,
    ).toBe(seed.sectionBytes.total);
    expect(seed.seedSha256).toBe(
      createHash("sha256").update(seed.seedText, "utf-8").digest("hex"),
    );
    expect(seed.sectionBytes.total).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.total,
    );
  });

  it("is deterministic: the same input renders the same bytes", () => {
    expect(built().seedText).toBe(built().seedText);
  });

  it("keeps every section within its own limit for a large conversation", () => {
    const entries: TranscriptEntryWithSeq[] = [];
    for (let seq = 0; seq < 60; seq++) {
      entries.push(
        text(
          seq,
          seq % 2 === 0 ? "user" : "assistant",
          `turn ${seq}: ${"詳細".repeat(400)}`,
        ),
      );
    }
    const seed = built(makeInput({ entries }));

    expect(seed.sectionBytes.workingState).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.workingState,
    );
    expect(seed.sectionBytes.recentDialogue).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.recentDialogue,
    );
    expect(seed.sectionBytes.recoveryFraming).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.recoveryFraming,
    );
    expect(seed.sectionBytes.total).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.total,
    );
    // The frozen string must still decode as the text it claims to be.
    expect(Buffer.from(seed.seedText, "utf8").toString("utf8")).toBe(
      seed.seedText,
    );
  });

  it("carries no raw SDK frames, image base64, or a previous checkpoint envelope", () => {
    const seed = built(
      makeInput({
        entries: [
          ...ENTRIES,
          entry(4, "user", [
            {
              type: "image",
              mediaType: "image/png",
              base64Data: "iVBORw0KGgoAAAANSUhEUg" + "A".repeat(400),
            },
          ]),
          entry(5, "assistant", [
            { type: "text", text: "read the file" },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "/tmp/x.ts", limit: 200 },
            },
          ]),
          entry(6, "assistant", [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "SECRET-TOOL-BODY ".repeat(200),
            },
          ]),
        ],
      }),
    );

    expect(seed.seedText).not.toContain("iVBORw0KGgo");
    expect(seed.seedText).not.toContain("SECRET-TOOL-BODY");
    expect(seed.seedText).not.toContain('"tool_use_id"');
    // The tool is still recoverable as a handle, through the complete-entry
    // export rather than the bounded reader.
    expect(seed.seedText).toContain("Read");
    expect(seed.seedText).toContain("cctl conversation entry get convo-1 5");
    expect(seed.seedText).toContain("cctl conversation entry get convo-1 6");
  });
});

describe("buildCheckpointSeed — working state", () => {
  it("renders every required field with its status, rationale, outcome, and refs", () => {
    const seed = built();

    expect(seed.seedText).toContain("deliver the bounded checkpoint seed");
    expect(seed.seedText).toContain("keep original evidence recoverable");
    expect(seed.seedText).toContain("the injected seed is at most 32768 bytes");
    expect(seed.seedText).toContain(
      "generate from the original archive, not the last summary",
    );
    expect(seed.seedText).toContain("accepted");
    expect(seed.seedText).toContain("rejected");
    expect(seed.seedText).toContain("a summary chain compounds loss");
    expect(seed.seedText).toContain("byte-to-token conversion for the budget");
    expect(seed.seedText).toContain(
      "rejected: the limit must be exact UTF-8 bytes",
    );
    expect(seed.seedText).toContain("which backends prove real continuation");
    expect(seed.seedText).toContain("freeze the rendered bytes and hash them");
    expect(seed.seedText).toContain("[#0 s0]");
  });

  it("labels an empty required field rather than inventing content", () => {
    const seed = built(
      makeInput({
        workingState: workingState({ blockers: [], nextActions: [] }),
      }),
    );

    expect(seed.seedText).toContain(CHECKPOINT_NOT_ESTABLISHED);
  });

  it("states that the seed is historical evidence, not a current approval", () => {
    const seed = built();
    expect(seed.seedText.toLowerCase()).toContain("historical");
  });

  it("refuses a source reference outside the captured boundary", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: workingState({
          nextActions: [
            {
              text: "cite a line that was never captured",
              sourceRefs: [{ messageIndex: 9, seqStart: 99, seqEnd: 99 }],
            },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "invalid_source_ref",
    );
  });

  it("refuses a message index beyond the recorded messages", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: workingState({
          blockers: [
            {
              text: "cite a message that does not exist",
              sourceRefs: [{ messageIndex: 99, seqStart: 1, seqEnd: 1 }],
            },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "invalid_source_ref",
    );
  });

  it("refuses an inverted source range", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: workingState({
          constraints: [
            {
              text: "backwards range",
              sourceRefs: [{ messageIndex: 0, seqStart: 3, seqEnd: 1 }],
            },
          ],
        }),
      }),
    );

    expect(result.ok).toBe(false);
  });

  function paddedState(padding: string): CheckpointWorkingState {
    return workingState({
      constraints: [
        {
          text: padding,
          sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
        },
      ],
    });
  }

  it("accepts a working state that fills its section exactly and refuses one byte more", () => {
    const probe = built(makeInput({ workingState: paddedState("x") }));
    const slack =
      CHECKPOINT_SEED_BUDGET.workingState - probe.sectionBytes.workingState;

    const exact = built(
      makeInput({ workingState: paddedState("x".repeat(1 + slack)) }),
    );
    expect(exact.sectionBytes.workingState).toBe(
      CHECKPOINT_SEED_BUDGET.workingState,
    );

    const over = buildCheckpointSeed(
      makeInput({ workingState: paddedState("x".repeat(2 + slack)) }),
    );
    expect(over.ok).toBe(false);
    if (over.ok) return;
    expect(over.issues.map((issue) => issue.code)).toContain(
      "working_state_too_large",
    );
  });

  it("measures the section in UTF-8 bytes, not JavaScript string length", () => {
    const probe = built(makeInput({ workingState: paddedState("x") }));
    const slack =
      CHECKPOINT_SEED_BUDGET.workingState - probe.sectionBytes.workingState;
    // Three-byte code points: well under the limit by string length, over it
    // by bytes.
    const padding = "日".repeat(Math.floor(slack / 3) + 1);
    expect(padding.length).toBeLessThan(CHECKPOINT_SEED_BUDGET.workingState);

    const result = buildCheckpointSeed(
      makeInput({ workingState: paddedState(padding) }),
    );
    expect(result.ok).toBe(false);
  });

  it("fails rather than truncating working state that exceeds its section limit", () => {
    const bulky = Array.from({ length: 400 }, (_, index) => ({
      text: `constraint ${index}: ${"x".repeat(200)}`,
      sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
    }));
    const result = buildCheckpointSeed(
      makeInput({ workingState: workingState({ constraints: bulky }) }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "working_state_too_large",
    );
  });
});

describe("buildCheckpointSeed — recent dialogue", () => {
  it("selects the newest exchanges and renders them chronologically with exact text", () => {
    const entries: TranscriptEntryWithSeq[] = [];
    for (let seq = 0; seq < 40; seq++) {
      entries.push(
        text(
          seq,
          seq % 2 === 0 ? "user" : "assistant",
          `turn ${seq} body ${"y".repeat(600)}`,
        ),
      );
    }
    const seed = built(makeInput({ entries }));

    const newest = seed.seedText.indexOf("turn 39 body");
    const older = seed.seedText.indexOf("turn 38 body");
    expect(newest).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(-1);
    // Chronological presentation: the older turn appears before the newest.
    expect(older).toBeLessThan(newest);
    // The oldest turns are outside the tail budget entirely.
    expect(seed.seedText).not.toContain("turn 0 body");
    expect(seed.seedText).toContain(`turn 39 body ${"y".repeat(600)}`);
    expect(
      seed.omissions.some(
        (omission) => omission.category === "recent_dialogue_units_omitted",
      ),
    ).toBe(true);
  });

  it("labels an oversized newest exchange as an excerpt with its recovery command", () => {
    const huge = "字".repeat(20_000);
    const seed = built(
      makeInput({
        entries: [...ENTRIES, text(4, "user", huge)],
      }),
    );

    expect(seed.seedText).toContain("excerpt");
    expect(seed.seedText).toContain("cctl conversation entry get convo-1 4");
    expect(seed.sectionBytes.recentDialogue).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.recentDialogue,
    );
    expect(Buffer.from(seed.seedText, "utf8").toString("utf8")).toBe(
      seed.seedText,
    );
    expect(
      seed.omissions.some(
        (omission) => omission.category === "recent_dialogue_excerpt",
      ),
    ).toBe(true);
  });

  it("never splits a multibyte character when excerpting", () => {
    const emoji = "🧭".repeat(8_000);
    const seed = built(
      makeInput({ entries: [...ENTRIES, text(4, "user", emoji)] }),
    );

    expect(seed.seedText).not.toContain("�");
    expect(Buffer.from(seed.seedText, "utf8").toString("utf8")).toBe(
      seed.seedText,
    );
  });
});

describe("buildCheckpointSeed — recovery and framing", () => {
  it("names the conversation, checkpoint, and captured boundary with ready-to-run commands", () => {
    const seed = built();

    expect(seed.seedText).toContain("convo-1");
    expect(seed.seedText).toContain("ckpt-1");
    expect(seed.seedText).toContain("s0–s3");
    expect(seed.seedText).toContain("cctl conversation read convo-1 --outline");
    expect(seed.seedText).toContain(
      "cctl conversation checkpoint get convo-1 ckpt-1 --detail seed",
    );
  });

  it("reduces evidence-map entries before any working-state field, and says so", () => {
    const entries: TranscriptEntryWithSeq[] = [];
    for (let seq = 0; seq < 300; seq++) {
      entries.push(
        text(seq, seq % 2 === 0 ? "user" : "assistant", `turn ${seq}`),
      );
    }
    const manyRefs = Array.from({ length: 300 }, (_, index) => ({
      text: `outstanding ${index}`,
      sourceRefs: [{ messageIndex: index, seqStart: index, seqEnd: index }],
    }));
    const seed = built(
      makeInput({
        entries,
        workingState: workingState({ outstandingRequests: manyRefs }),
      }),
    );

    expect(seed.sectionBytes.recoveryFraming).toBeLessThanOrEqual(
      CHECKPOINT_SEED_BUDGET.recoveryFraming,
    );
    expect(seed.seedText).toContain("outstanding 299");
    expect(
      seed.omissions.some(
        (omission) => omission.category === "evidence_map_truncated",
      ),
    ).toBe(true);
  });
});

describe("buildCheckpointSeed — source references anchor to real messages", () => {
  const MERGED_ENTRIES: TranscriptEntryWithSeq[] = [
    text(0, "user", "build the checkpoint seed"),
    text(1, "assistant", "starting with the budget module"),
    text(2, "assistant", "then the builder"),
    text(3, "user", "keep the archive recoverable"),
  ];

  function withRef(ref: {
    messageIndex: number;
    seqStart: number;
    seqEnd: number;
  }): CheckpointWorkingState {
    return workingState({
      constraints: [{ text: "cited constraint", sourceRefs: [ref] }],
    });
  }

  it("accepts a range that stays inside one merged logical message", () => {
    const seed = built(
      makeInput({
        entries: MERGED_ENTRIES,
        workingState: workingState({
          objective: {
            text: "deliver the bounded checkpoint seed",
            sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
          },
          latestRequest: {
            text: "keep the archive recoverable",
            sourceRefs: [{ messageIndex: 2, seqStart: 3, seqEnd: 3 }],
          },
          outstandingRequests: [
            {
              text: "keep original evidence recoverable",
              sourceRefs: [{ messageIndex: 2, seqStart: 3, seqEnd: 3 }],
            },
          ],
          constraints: [
            {
              text: "the merged assistant turn",
              sourceRefs: [{ messageIndex: 1, seqStart: 1, seqEnd: 2 }],
            },
          ],
          decisions: [],
          failedApproaches: [],
          openQuestions: [],
          nextActions: [],
        }),
      }),
    );

    expect(seed.seedText).toContain("[#1 s1–s2]");
  });

  it("refuses a raw sequence the archive never recorded", () => {
    const entries = [...ENTRIES, text(9, "user", "later turn")];
    const result = buildCheckpointSeed(
      makeInput({
        entries,
        workingState: withRef({ messageIndex: 4, seqStart: 7, seqEnd: 7 }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "invalid_source_ref",
    );
  });

  it("refuses a sequence that belongs to a different logical message", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: withRef({ messageIndex: 0, seqStart: 2, seqEnd: 2 }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "invalid_source_ref",
    );
  });

  it("refuses a whole-archive range attributed to one message", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: withRef({ messageIndex: 0, seqStart: 0, seqEnd: 3 }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "invalid_source_ref",
    );
  });

  it("requires a narrow reference for an established objective and latest request", () => {
    for (const field of ["objective", "latestRequest"] as const) {
      const result = buildCheckpointSeed(
        makeInput({
          workingState: workingState({
            [field]: { text: "an asserted fact", sourceRefs: [] },
          }),
        }),
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.issues.map((issue) => issue.code)).toContain(
        "missing_source_ref",
      );
      expect(result.issues.some((issue) => issue.detail.includes(field))).toBe(
        true,
      );
    }
  });

  it("accepts an explicitly unestablished objective with no reference", () => {
    const seed = built(
      makeInput({
        workingState: workingState({
          objective: { text: CHECKPOINT_NOT_ESTABLISHED, sourceRefs: [] },
        }),
      }),
    );

    expect(seed.seedText).toContain(`Objective: ${CHECKPOINT_NOT_ESTABLISHED}`);
  });

  it("refuses an unestablished field that still cites evidence", () => {
    const result = buildCheckpointSeed(
      makeInput({
        workingState: workingState({
          objective: {
            text: CHECKPOINT_NOT_ESTABLISHED,
            sourceRefs: [{ messageIndex: 0, seqStart: 0, seqEnd: 0 }],
          },
        }),
      }),
    );

    expect(result.ok).toBe(false);
  });
});

describe("buildCheckpointSeed — every rendered section stays within its budget", () => {
  const SATURATING_ENTRIES: TranscriptEntryWithSeq[] = Array.from(
    { length: 300 },
    (_, seq) => text(seq, seq % 2 === 0 ? "user" : "assistant", `turn ${seq}`),
  );

  /**
   * Evidence lines of one fixed width, so growing the framing head by a byte
   * either grows the section by a byte or drops exactly one line: sweeping the
   * head walks the rendered section through every byte count around its limit,
   * including the exact fit where an unbudgeted separator overflows it.
   */
  function saturatedInput(
    checkpointId: string,
    ordinal: number,
  ): BuildCheckpointSeedInput {
    return makeInput({
      identity: {
        conversationId: "convo-1",
        checkpointId,
        ordinal,
        scope: "session",
      },
      entries: SATURATING_ENTRIES,
      workingState: workingState({
        outstandingRequests: Array.from({ length: 200 }, (_, index) => ({
          text: `outstanding ${index}`,
          sourceRefs: [
            {
              messageIndex: 100 + index,
              seqStart: 100 + index,
              seqEnd: 100 + index,
            },
          ],
        })),
      }),
    });
  }

  it("never exceeds the framing limit, including at an exact fit", () => {
    let widest = 0;
    for (let idLength = 1; idLength <= 90; idLength++) {
      for (const ordinal of [1, 10]) {
        const seed = built(saturatedInput("k".repeat(idLength), ordinal));
        expect(seed.sectionBytes.recoveryFraming).toBeLessThanOrEqual(
          CHECKPOINT_SEED_BUDGET.recoveryFraming,
        );
        expect(seed.sectionBytes.total).toBeLessThanOrEqual(
          CHECKPOINT_SEED_BUDGET.total,
        );
        widest = Math.max(widest, seed.sectionBytes.recoveryFraming);
      }
    }
    // The sweep reached the exact limit, so the assertion above was tested at
    // the boundary and not merely somewhere below it.
    expect(widest).toBe(CHECKPOINT_SEED_BUDGET.recoveryFraming);
  });

  it("reports the exact rendered byte count of every section", () => {
    const seed = built(saturatedInput("ckpt-1", 1));
    const framingEnd = seed.seedText.indexOf("## Working state");
    const dialogueStart = seed.seedText.indexOf("## Recent dialogue");

    expect(seed.sectionBytes.recoveryFraming).toBe(
      utf8ByteLength(seed.seedText.slice(0, framingEnd)),
    );
    expect(seed.sectionBytes.recentDialogue).toBe(
      utf8ByteLength(seed.seedText.slice(dialogueStart)),
    );
  });

  it("fails rather than emitting framing that its identity alone overflows", () => {
    const result = buildCheckpointSeed(
      makeInput({
        identity: {
          conversationId: "c".repeat(3_000),
          checkpointId: "k".repeat(3_000),
          ordinal: 1,
          scope: "session",
        },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(
      "recovery_framing_too_large",
    );
  });
});

describe("current advisory handoff fitting", () => {
  const agentHandoff = {
    plan: [
      {
        kind: "belief" as const,
        text: "ADVISORY_ONLY 🧭 <task> ```",
        sourceRefs: [],
      },
    ],
    hypotheses: [],
    failedApproaches: [],
    blockers: [],
    nextStep: [],
  };
  it("renders advisory data separately and leaves missing evidence unestablished", () => {
    const state = workingState({
      objective: { text: CHECKPOINT_NOT_ESTABLISHED, sourceRefs: [] },
    });
    const baseline = built(makeInput({ workingState: state }));
    const seed = built(makeInput({ workingState: state, agentHandoff }));
    expect(seed.handoffDecision).toBe("included");
    expect(seed.sections.workingState).toMatchObject({
      objective: state.objective,
      agentHandoff: {
        candidate: agentHandoff,
        categoryCounts: {
          plan: 1,
          hypotheses: 0,
          failedApproaches: 0,
          blockers: 0,
          nextStep: 0,
        },
      },
    });
    expect(seed.seedText).toContain(
      "Agent handoff — advisory account at capture time",
    );
    expect(seed.seedText).toContain(`Objective: ${CHECKPOINT_NOT_ESTABLISHED}`);
    expect(seed.seedText).not.toContain("<task>");
    expect(seed.sectionBytes.total).toBe(Buffer.byteLength(seed.seedText));
    expect(seed.seedSha256).not.toBe(baseline.seedSha256);
    expect(seed.seedSha256).toBe(
      createHash("sha256").update(seed.seedText).digest("hex"),
    );
  });
  it("includes an exact fit and omits the whole handoff one byte over without reducing evidence", () => {
    const initial = built(makeInput({ agentHandoff }));
    const state = workingState();
    state.objective.text += "x".repeat(
      CHECKPOINT_SEED_BUDGET.workingState - initial.sectionBytes.workingState,
    );
    const exact = built(makeInput({ workingState: state, agentHandoff }));
    expect(exact.handoffDecision).toBe("included");
    expect(exact.sectionBytes.workingState).toBe(18432);
    state.objective.text += "x";
    const baseline = built(makeInput({ workingState: state }));
    const omitted = built(makeInput({ workingState: state, agentHandoff }));
    expect(omitted.handoffDecision).toBe("seed_budget");
    expect(omitted.seedText).toBe(baseline.seedText);
    expect(omitted.seedSha256).toBe(baseline.seedSha256);
    expect(omitted.sections).toEqual(baseline.sections);
    expect(omitted.sectionBytes).toEqual(baseline.sectionBytes);
    expect(omitted.omissions).toContainEqual(
      expect.objectContaining({
        category: "handoff_omitted",
        detail: "seed_budget",
      }),
    );
  });
  it("refuses capture-origin references in authoritative recorded evidence", () => {
    const entries = ENTRIES.map((entry) =>
      entry.seq === 1
        ? {
            ...entry,
            origin: {
              source: "checkpoint_capture" as const,
              checkpointCapture: {
                operationId: "op",
                captureId: "capture",
                part: "output" as const,
              },
            },
          }
        : entry,
    );
    const result = buildCheckpointSeed(makeInput({ entries, agentHandoff }));
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "invalid_source_ref" }),
      ]),
    });
  });
});
