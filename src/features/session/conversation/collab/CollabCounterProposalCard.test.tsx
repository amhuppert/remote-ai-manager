// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabCounterProposalCard from "@/features/session/conversation/collab/CollabCounterProposalCard";

describe("CollabCounterProposalCard", () => {
  it("renders the summary narrative through the compact canonical adapter", async () => {
    const { container } = render(
      <CollabCounterProposalCard
        fromAgent="codex"
        round={2}
        summary="Counter uses ~~old~~ **new** terms."
        artifacts={[]}
        accepted_change_ids={[]}
        rejected_change_ids={[]}
        alternative_changes={[]}
        agree={[]}
        disagree={[]}
        defaultOpen
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-markdown-intent="compact"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("new").tagName).toBe("STRONG");
    expect(screen.getByText("old").tagName).toBe("DEL");
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });
});
