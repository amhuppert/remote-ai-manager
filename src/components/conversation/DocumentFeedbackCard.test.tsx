// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DocumentFeedbackItem } from "@/lib/conversations/message-content-schemas";
import DocumentFeedbackCard from "./DocumentFeedbackCard";

const ITEM_A: DocumentFeedbackItem = {
  docPath: ".kiro/specs/x/design.md",
  path: ".kiro/specs/x/design.md",
  headingLabel: "Prompt pipeline extension",
  line: 42,
  quote: "the exact quoted passage",
  note: "please reconsider this section",
};

const ITEM_B: DocumentFeedbackItem = {
  docPath: "README.md",
  path: "README.md",
  headingLabel: "Getting started",
  line: 7,
  quote: "run the dev server",
  note: "this command is out of date",
};

describe("DocumentFeedbackCard", () => {
  it("renders each item's path, heading + line, quote, and note", () => {
    render(<DocumentFeedbackCard items={[ITEM_A, ITEM_B]} />);

    for (const item of [ITEM_A, ITEM_B]) {
      expect(screen.getByText(item.path)).toBeInTheDocument();
      expect(
        screen.getByText(`§ ${item.headingLabel} · L${item.line}`),
      ).toBeInTheDocument();
      // The quote is wrapped in typographic quotation marks.
      expect(screen.getByText(new RegExp(item.quote))).toBeInTheDocument();
      expect(screen.getByText(item.note)).toBeInTheDocument();
    }
  });

  it("shows the item count in the header when there is more than one item", () => {
    render(<DocumentFeedbackCard items={[ITEM_A, ITEM_B]} />);
    expect(
      screen.getByText(/Document feedback · 2 locations/),
    ).toBeInTheDocument();
  });

  it("uses the singular header for a single item", () => {
    render(<DocumentFeedbackCard items={[ITEM_A]} />);
    expect(
      screen.getByText(/Document feedback · 1 location/),
    ).toBeInTheDocument();
  });
});
