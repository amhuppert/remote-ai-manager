// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import CollabInitialDraftCard from "@/features/session/conversation/collab/CollabInitialDraftCard";

describe("CollabInitialDraftCard", () => {
  it("renders the summary narrative through the compact canonical adapter", async () => {
    const { container } = render(
      <CollabInitialDraftCard
        agent="claude"
        isPrimary
        summary="Draft uses ~~old~~ **new** framing."
        artifacts={[]}
        assumptions={[]}
        key_claims={[]}
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
    // No local dynamic loader fallback, no generated-descendant CSS hook.
    expect(container.querySelector(".markdown-loading")).toBeNull();
    expect(container.querySelector(".collab-markdown-text")).toBeNull();
  });
});
