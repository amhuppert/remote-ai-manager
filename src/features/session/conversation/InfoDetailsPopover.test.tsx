// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InfoDetailsPopover from "@/features/session/conversation/InfoDetailsPopover";

// Mock clipboard API
beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("InfoDetailsPopover", () => {
  const baseProps = {
    conversationId: "c3e2c1cc-abcd-1234-5678-abcdef012345",
    backendRef: {
      backend: "claude" as const,
      sessionId: "sess_abc123xyz",
    },
    createdAt: "2026-04-15T16:15:00Z",
    worktreePath: "/home/alex/github/remote-ai-manager/.worktrees/my-branch",
  };

  it("renders the info button", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    expect(screen.getByRole("button", { name: /details/i })).toBeTruthy();
  });

  it("does not show popover content by default", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    expect(screen.queryByText("Conversation ID")).toBeNull();
  });

  it("shows popover content when button is clicked", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText("Conversation ID")).toBeTruthy();
    expect(screen.getByText("Session Ref")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    expect(screen.getByText("Worktree")).toBeTruthy();
  });

  it("formats Claude backend ref correctly", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText("sess_abc123xyz")).toBeTruthy();
  });

  it("formats Codex backend ref correctly", () => {
    render(
      <InfoDetailsPopover
        {...baseProps}
        backendRef={{ backend: "codex", threadId: "thread_xyz789" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText("thread_xyz789")).toBeTruthy();
  });

  it("shows em-dash when backendRef is null", () => {
    render(<InfoDetailsPopover {...baseProps} backendRef={null} />);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    // The session ref value should show em-dash
    const refRow = screen.getByText("Session Ref").closest(".info-popover-row");
    expect(refRow?.querySelector(".info-popover-val")?.textContent).toBe("—");
  });

  it("copies value to clipboard when copy button is clicked", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    // Click the copy button next to Conversation ID
    const rows = document.querySelectorAll(".info-popover-row");
    const copyBtn = rows[0]?.querySelector(".info-popover-copy");
    expect(copyBtn).toBeTruthy();
    fireEvent.click(copyBtn!);
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "c3e2c1cc-abcd-1234-5678-abcdef012345",
    );
  });

  it("closes popover when clicking outside", () => {
    render(
      <div>
        <InfoDetailsPopover {...baseProps} />
        <div data-testid="outside">outside</div>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /details/i }));
    expect(screen.getByText("Conversation ID")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("Conversation ID")).toBeNull();
  });
});
