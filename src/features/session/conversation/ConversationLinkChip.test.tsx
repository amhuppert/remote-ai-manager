// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import ConversationLinkChip from "./ConversationLinkChip";
import type { ConversationRefAttrs } from "@/lib/conversations/schemas";

function makeAttrs(
  overrides: Partial<ConversationRefAttrs> = {},
): ConversationRefAttrs {
  return {
    "project-name": "my-app",
    "project-path": "/repos/my-app",
    "session-name": "main",
    "worktree-path": "/repos/my-app/.worktrees/main",
    "conversation-id": "conv-123",
    "conversation-name": "Refactor parser",
    backend: "claude",
    "backend-ref": "claude-sess-abc",
    "debug-log-path": "",
    status: "running",
    "last-activity-at": "2024-06-01T12:00:00Z",
    ...overrides,
  };
}

describe("ConversationLinkChip", () => {
  it("renders an anchor pointing at the conversation URL", () => {
    render(<ConversationLinkChip attrs={makeAttrs()} />);

    const anchor = screen.getByRole("link");
    expect(anchor).toHaveAttribute("href", "/conversations?c=conv-123");
  });

  it("URL-encodes a conversation id containing special characters", () => {
    render(
      <ConversationLinkChip
        attrs={makeAttrs({ "conversation-id": "conv 1" })}
      />,
    );

    const anchor = screen.getByRole("link");
    expect(anchor).toHaveAttribute("href", "/conversations?c=conv%201");
  });

  it("renders the conversation name when present", () => {
    render(<ConversationLinkChip attrs={makeAttrs()} />);
    expect(screen.getByText("Refactor parser")).toBeInTheDocument();
  });

  it("falls back to conversation-id when conversation-name is empty", () => {
    render(
      <ConversationLinkChip attrs={makeAttrs({ "conversation-name": "" })} />,
    );
    expect(screen.getByText("conv-123")).toBeInTheDocument();
  });

  it("applies data-backend reflecting the backend attribute", () => {
    render(<ConversationLinkChip attrs={makeAttrs({ backend: "codex" })} />);
    expect(screen.getByRole("link")).toHaveAttribute("data-backend", "codex");
  });

  it("sets a tooltip showing project · session", () => {
    render(<ConversationLinkChip attrs={makeAttrs()} />);
    expect(screen.getByRole("link")).toHaveAttribute("title", "my-app · main");
  });
});
