import { describe, expect, it } from "vitest";
import { appendStructuredOutputInstruction } from "@/lib/agent-backends/structured-output-prompt";
import type { TranscriptEntryWithSeq } from "@/lib/prompt/transcript";
import { buildHandoffPrompt, validateHandoffCandidate } from "./handoff";

const empty = {
  plan: [],
  hypotheses: [],
  failedApproaches: [],
  blockers: [],
  nextStep: [],
};
const origin = {
  source: "checkpoint_capture",
  checkpointCapture: {
    operationId: "op",
    captureId: "op:capture",
    part: "control",
  },
} as const;
const entries: TranscriptEntryWithSeq[] = [
  {
    seq: 0,
    entryId: null,
    timestamp: null,
    role: "user",
    content: [{ type: "text", text: "real task" }],
  },
  {
    seq: 1,
    entryId: null,
    timestamp: null,
    role: "user",
    content: [{ type: "text", text: "control" }],
    origin,
  },
  {
    seq: 2,
    entryId: null,
    timestamp: null,
    role: "user",
    content: [{ type: "text", text: "constraint" }],
  },
  {
    seq: 3,
    entryId: null,
    timestamp: null,
    role: "assistant",
    content: [{ type: "text", text: "observed" }],
  },
];
const validate = (value: unknown) =>
  validateHandoffCandidate({ answerText: JSON.stringify(value), entries });

describe("bounded advisory handoff", () => {
  it("counts exact framed input, including schema and Unicode capture marker at 8192/8193", () => {
    const base = buildHandoffPrompt("🧭");
    expect(base.ok).toBe(true);
    if (!base.ok) throw new Error("default prompt exceeds budget");
    expect(base.inputBytes).toBe(Buffer.byteLength(base.promptText));
    expect(
      appendStructuredOutputInstruction(base.promptText, base.outputSchema),
    ).toBe(base.promptText);
    const marker = `🧭${"x".repeat(8192 - base.inputBytes)}`;
    expect(buildHandoffPrompt(marker)).toMatchObject({
      ok: true,
      inputBytes: 8192,
    });
    expect(buildHandoffPrompt(marker + "x")).toEqual({
      ok: false,
      reason: "input_limit",
    });
  });
  it("accepts explicitly empty categories and uncited beliefs/proposals", () => {
    expect(validate(empty)).toMatchObject({ ok: true, candidate: empty });
    expect(
      validate({
        ...empty,
        hypotheses: [{ kind: "belief", text: "maybe caching", sourceRefs: [] }],
        nextStep: [
          { kind: "proposal", text: "inspect caching", sourceRefs: [] },
        ],
      }),
    ).toMatchObject({ ok: true });
  });
  it("counts fences and whitespace at 6144/6145 final-answer bytes", () => {
    const body = `\`\`\`json\n${JSON.stringify({ ...empty, hypotheses: [{ kind: "belief", text: "🧭é", sourceRefs: [] }] })}\n\`\`\``;
    const exact = body + " ".repeat(6144 - Buffer.byteLength(body));
    expect(
      validateHandoffCandidate({ answerText: exact, entries }),
    ).toMatchObject({ ok: true, outputBytes: 6144 });
    expect(
      validateHandoffCandidate({ answerText: exact + "x", entries }),
    ).toEqual({ ok: false, reason: "output_limit" });
  });
  it.each([
    "",
    "not json",
    "{}",
    JSON.stringify({ ...empty, objective: "new task" }),
    JSON.stringify({
      ...empty,
      plan: [{ kind: "reported_observation", text: "passed", sourceRefs: [] }],
    }),
  ])("rejects invalid output without repair: %s", (answerText) => {
    expect(validateHandoffCandidate({ answerText, entries })).toEqual({
      ok: false,
      reason: "invalid_output",
    });
  });
  it.each([
    { messageIndex: 0, seqStart: 1, seqEnd: 1 },
    { messageIndex: 0, seqStart: 0, seqEnd: 2 },
    { messageIndex: 0, seqStart: 3, seqEnd: 3 },
    { messageIndex: 1, seqStart: 3, seqEnd: 4 },
  ])(
    "rejects capture parts, capture-spanning ranges and foreign/missing coordinates",
    (ref) => {
      expect(
        validate({
          ...empty,
          plan: [
            {
              kind: "reported_observation",
              text: "observed",
              sourceRefs: [ref],
            },
          ],
        }),
      ).toEqual({ ok: false, reason: "invalid_output" });
    },
  );
  it("preserves original references, redacts and canonicalizes accepted claims", () => {
    const ref = { messageIndex: 1, seqStart: 3, seqEnd: 3 };
    const result = validate({
      ...empty,
      plan: [
        {
          kind: "reported_observation",
          text: "api_key = sk-abcdefghijklmnopqrstuvwxyz012345",
          sourceRefs: [ref],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("valid observation rejected");
    expect(result.canonicalJson).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(result.canonicalJson).toContain("REDACTED");
    expect(result.candidate.plan[0]?.sourceRefs).toEqual([ref]);
    expect(JSON.parse(result.canonicalJson)).toEqual(result.candidate);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not classify temporary capture restrictions in advisory prose as structurally invalid", () => {
    expect(
      validate({
        ...empty,
        blockers: [
          {
            kind: "belief",
            text: "I cannot use tools during capture",
            sourceRefs: [],
          },
        ],
      }),
    ).toMatchObject({ ok: true });
  });
});
