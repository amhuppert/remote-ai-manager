// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabCrossReviewCard from "@/features/session/conversation/collab/CollabCrossReviewCard";

describe("CollabCrossReviewCard", () => {
  it("renders the summary narrative through the compact canonical adapter", async () => {
    const { container } = render(
      <CollabCrossReviewCard
        reviewerAgent="claude"
        targetAgent="codex"
        summary="Review flags ~~drafts~~ **canonical** rendering."
        artifacts={[]}
        agree={[]}
        disagree={[]}
        revise_self={[]}
        defaultOpen
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-markdown-intent="compact"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("canonical").tagName).toBe("STRONG");
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });

  it("keeps a long unbroken narrative token inside the overflow-safe compact root when the card is narrow", async () => {
    const longToken = "n".repeat(220);
    const { container } = render(
      <div style={{ width: 180 }}>
        <CollabCrossReviewCard
          reviewerAgent="claude"
          targetAgent="codex"
          summary={longToken}
          artifacts={[]}
          agree={[]}
          disagree={[]}
          revise_self={[]}
          defaultOpen
        />
      </div>,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-markdown-intent="compact"]'),
      ).not.toBeNull(),
    );
    const root = container.querySelector<HTMLElement>(
      '[data-markdown-intent="compact"]',
    );
    expect(root?.textContent).toContain(longToken);
    // Overflow safety comes from the canonical module, not card CSS.
    expect(root?.className).toContain("min-w-0");
    expect(root?.className).toContain("break-words");
  });
});
