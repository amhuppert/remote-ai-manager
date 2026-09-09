/**
 * The corpus's independence contract. These assertions are what let a probe
 * report "the continued conversation still knows this" as evidence: the
 * oracle has to be readable out of the original dialogue, so a checkpoint
 * that invented or dropped the fact cannot quietly define the answer.
 */

import { describe, expect, it } from "vitest";

import {
  CONTINUITY_CORPUS,
  assembleContinuityTranscript,
  gradeContinuityAnswer,
  type ContinuityCase,
  type ContinuityExpectationKind,
} from "./continuity-corpus";
import type { TranscriptEntry } from "@/lib/prompt/transcript";

const IMAGE_REF_PATH = "/scratch/probe/images/latency-chart.png";

/** Every literal a fixture entry contributes to the dialogue's text. */
function entryText(entry: TranscriptEntry): string {
  return (entry.content ?? [])
    .map((block) => {
      if (block.type === "text" || block.type === "thinking") return block.text;
      if (block.type === "tool_result") return block.content ?? "";
      if (block.type === "tool_use") return JSON.stringify(block.input ?? {});
      return "";
    })
    .join("\n");
}

function caseText(fixture: ContinuityCase): string {
  return fixture.entries.map(entryText).join("\n").toLowerCase();
}

const REQUIRED_KINDS: ContinuityExpectationKind[] = [
  "constraint",
  "identifier",
  "rejected_approach",
  "superseded_decision",
  "blocker",
  "next_action",
];

describe("the continuity corpus", () => {
  it("covers every expectation kind the probe reports on", () => {
    const kinds = new Set(
      CONTINUITY_CORPUS.flatMap((fixture) =>
        fixture.expectations.map((expectation) => expectation.kind),
      ),
    );
    expect([...kinds].sort()).toEqual([...REQUIRED_KINDS].sort());
  });

  it("carries tool-heavy, oversized and image-dependent dialogue", () => {
    const traits = new Set(CONTINUITY_CORPUS.flatMap((f) => f.traits));
    expect(traits).toEqual(
      new Set(["tool_heavy", "oversized", "image_dependent"]),
    );
    const oversized = CONTINUITY_CORPUS.filter((f) =>
      f.traits.includes("oversized"),
    ).flatMap((f) =>
      f.entries.map((entry) => Buffer.byteLength(entryText(entry), "utf-8")),
    );
    // Larger than the recent-dialogue budget, so the newest-exchange excerpt
    // path is exercised rather than described.
    expect(Math.max(...oversized)).toBeGreaterThan(10_240);
    const imageBlocks = CONTINUITY_CORPUS.filter((f) =>
      f.traits.includes("image_dependent"),
    ).flatMap((f) => f.entries.flatMap((entry) => entry.content ?? []));
    expect(imageBlocks.some((block) => block.type === "image")).toBe(true);
    expect(imageBlocks.some((block) => block.type === "image_ref")).toBe(true);
    const toolBlocks = CONTINUITY_CORPUS.filter((f) =>
      f.traits.includes("tool_heavy"),
    ).flatMap((f) => f.entries.flatMap((entry) => entry.content ?? []));
    expect(
      toolBlocks.filter((b) => b.type === "tool_use").length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      toolBlocks.filter((b) => b.type === "tool_result").length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("asks a fact from the earliest dialogue only after the third checkpoint", () => {
    const survivors = CONTINUITY_CORPUS.flatMap((f) =>
      f.expectations.filter((e) => e.askAfterCycle === 3),
    );
    expect(survivors.length).toBeGreaterThanOrEqual(2);
    const cycles = new Set(
      CONTINUITY_CORPUS.flatMap((f) =>
        f.expectations.map((e) => e.askAfterCycle),
      ),
    );
    expect(cycles).toEqual(new Set([1, 2, 3]));
  });

  it("carries a fact only the original image can answer", () => {
    const imageBacked = CONTINUITY_CORPUS.flatMap((fixture) =>
      fixture.expectations
        .filter((expectation) => expectation.evidence === "image")
        .map((expectation) => ({ fixture, expectation })),
    );

    // Without this, an "image-dependent" case proves nothing about images:
    // every fact would still be recoverable from the surrounding text, and
    // deleting all the pixels would not change a single grade.
    expect(imageBacked.length).toBeGreaterThan(0);

    for (const { fixture, expectation } of imageBacked) {
      const text = caseText(fixture);
      for (const literal of expectation.mustInclude) {
        expect(
          text.includes(literal.toLowerCase()),
          `${expectation.id}: "${literal}" is stated in the dialogue, so the image is decorative`,
        ).toBe(false);
      }
    }
  });

  it.each(CONTINUITY_CORPUS.map((fixture) => [fixture.id, fixture] as const))(
    "%s: authors every expected and superseded literal out of its own dialogue",
    (_id, fixture) => {
      const text = caseText(fixture);
      for (const expectation of fixture.expectations) {
        expect(expectation.mustInclude.length).toBeGreaterThan(0);
        // An image-backed fact is authored out of the pixels; the rule that it
        // appear in the dialogue is inverted for it, and lives in its own test.
        if (expectation.evidence === "image") continue;
        for (const literal of expectation.mustInclude) {
          expect(
            text.includes(literal.toLowerCase()),
            `${expectation.id}: "${literal}" is not in the source dialogue`,
          ).toBe(true);
        }
        for (const literal of expectation.mustNotInclude) {
          expect(
            text.includes(literal.toLowerCase()),
            `${expectation.id}: superseded "${literal}" is not in the source dialogue`,
          ).toBe(true);
        }
        for (const index of expectation.sourceEntryIndexes) {
          const entry = fixture.entries[index];
          expect(
            entry,
            `${expectation.id}: entry ${index} is missing`,
          ).toBeDefined();
        }
        const cited = expectation.sourceEntryIndexes
          .map((index) => entryText(fixture.entries[index] as TranscriptEntry))
          .join("\n")
          .toLowerCase();
        expect(
          expectation.mustInclude.some((literal) =>
            cited.includes(literal.toLowerCase()),
          ),
          `${expectation.id}: cited entries do not establish the fact`,
        ).toBe(true);
      }
    },
  );

  it("gives every expectation a unique id", () => {
    const ids = CONTINUITY_CORPUS.flatMap((f) =>
      f.expectations.map((e) => e.id),
    );
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("assembling the probe transcript", () => {
  it("lays the cases out as JSONL lines whose index is the raw sequence", () => {
    const assembled = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    const total = CONTINUITY_CORPUS.reduce(
      (sum, f) => sum + f.entries.length,
      0,
    );
    expect(assembled.lines).toHaveLength(total);
    for (const line of assembled.lines) {
      expect(line.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(line.role === "user" || line.role === "assistant").toBe(true);
      expect((line.content ?? []).length).toBeGreaterThan(0);
    }
  });

  it("resolves case-relative entry indexes to absolute sequences", () => {
    const assembled = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    let offset = 0;
    for (const fixture of CONTINUITY_CORPUS) {
      for (const expectation of fixture.expectations) {
        const resolved = assembled.expectations.find(
          (e) => e.id === expectation.id,
        );
        expect(resolved?.caseId).toBe(fixture.id);
        expect(resolved?.sourceSeqs).toEqual(
          expectation.sourceEntryIndexes.map((index) => index + offset),
        );
      }
      offset += fixture.entries.length;
    }
  });

  it("substitutes the caller's image path into the external reference", () => {
    const assembled = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    const refs = assembled.lines
      .flatMap((line) => line.content ?? [])
      .filter((block) => block.type === "image_ref");
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.type === "image_ref" && ref.imagePath).toBe(IMAGE_REF_PATH);
    }
  });

  it("keeps the generated source bounded so a probe's model cost stays predictable", () => {
    const assembled = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    const bytes = assembled.lines.reduce(
      (sum, line) => sum + Buffer.byteLength(JSON.stringify(line), "utf-8"),
      0,
    );
    expect(bytes).toBeGreaterThan(20_000);
    expect(bytes).toBeLessThan(120_000);
  });

  it("is byte-identical across assemblies, so an archive hash means something", () => {
    const first = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    const second = assembleContinuityTranscript({
      imageRefPath: IMAGE_REF_PATH,
    });
    expect(JSON.stringify(second.lines)).toBe(JSON.stringify(first.lines));
  });
});

describe("grading an answer", () => {
  const expectation = {
    mustInclude: ["ledger-exports-v2"],
    mustNotInclude: ["ledger-exports-v1"],
  };

  it("accepts the expected literal regardless of case and spacing", () => {
    expect(
      gradeContinuityAnswer("The bucket is  LEDGER-EXPORTS-V2 .", expectation),
    ).toEqual({ satisfied: true, missing: [], forbidden: [] });
  });

  it("reports each missing literal rather than a bare failure", () => {
    expect(
      gradeContinuityAnswer("I don't recall the bucket.", {
        mustInclude: ["ledger-exports-v2", "RCN-4417"],
        mustNotInclude: [],
      }),
    ).toEqual({
      satisfied: false,
      missing: ["ledger-exports-v2", "RCN-4417"],
      forbidden: [],
    });
  });

  it("fails an answer that names the superseded value", () => {
    expect(gradeContinuityAnswer("ledger-exports-v1", expectation)).toEqual({
      satisfied: false,
      missing: ["ledger-exports-v2"],
      forbidden: ["ledger-exports-v1"],
    });
  });

  it("matches a multi-word literal across a line break", () => {
    expect(
      gradeContinuityAnswer("it buffers the whole\nresult set", {
        mustInclude: ["whole result set"],
        mustNotInclude: [],
      }).satisfied,
    ).toBe(true);
  });
});
