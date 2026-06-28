import { describe, expect, it } from "vitest";
import { formatDocumentFeedbackPrompt } from "./format-feedback";
import type { DocumentFeedbackItem } from "./schemas";

const ITEM_A: DocumentFeedbackItem = {
  docPath: ".kiro/specs/x/design.md",
  path: ".kiro/specs/x/design.md",
  headingLabel: "2 › 2.1 Design",
  line: 42,
  quote: "the best code is no code",
  note: "Tighten this paragraph.",
};

const ITEM_B: DocumentFeedbackItem = {
  docPath: "memory-bank/focus.md",
  path: "memory-bank/focus.md",
  headingLabel: "Current Focus",
  line: 7,
  quote: "remaining tasks",
  note: "List them explicitly.",
};

describe("formatDocumentFeedbackPrompt", () => {
  it("embeds path, heading, line, quote, and note for a single item", () => {
    const text = formatDocumentFeedbackPrompt([ITEM_A]);
    expect(text).toContain(ITEM_A.path);
    expect(text).toContain(`§ ${ITEM_A.headingLabel}`);
    expect(text).toContain(`L${ITEM_A.line}`);
    expect(text).toContain(ITEM_A.quote);
    expect(text).toContain(ITEM_A.note);
  });

  it("renders every item when several are sent", () => {
    const text = formatDocumentFeedbackPrompt([ITEM_A, ITEM_B]);
    for (const item of [ITEM_A, ITEM_B]) {
      expect(text).toContain(item.path);
      expect(text).toContain(`§ ${item.headingLabel}`);
      expect(text).toContain(`L${item.line}`);
      expect(text).toContain(item.quote);
      expect(text).toContain(item.note);
    }
  });

  it("returns a non-empty string", () => {
    expect(formatDocumentFeedbackPrompt([ITEM_A]).length).toBeGreaterThan(0);
  });
});
