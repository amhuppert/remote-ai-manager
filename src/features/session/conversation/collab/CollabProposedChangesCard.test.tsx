// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabProposedChangesCard from "@/features/session/conversation/collab/CollabProposedChangesCard";

describe("CollabProposedChangesCard", () => {
  it("renders the summary narrative through the compact canonical adapter", async () => {
    const { container } = render(
      <CollabProposedChangesCard
        fromAgent="claude"
        round={1}
        summary="Proposes ~~old~~ **new** structure."
        artifacts={[]}
        accepted_from_other_agent_draft={[]}
        proposed_changes={[]}
        remaining_disagreements={[]}
        defaultOpen
      />,
    );

    await waitFor(() =>
      expect(
        container.querySelector('[data-markdown-intent="compact"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText("new").tagName).toBe("STRONG");
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });
});
