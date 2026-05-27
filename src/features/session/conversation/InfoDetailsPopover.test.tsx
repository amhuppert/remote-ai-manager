// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import InfoDetailsPopover from "@/features/session/conversation/InfoDetailsPopover";

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

const baseProps = {
  conversationId: "c3e2c1cc-abcd-1234-5678-abcdef012345",
  backendRef: {
    backend: "claude" as const,
    sessionId: "sess_abc123xyz",
  },
  createdAt: "2026-04-15T16:15:00Z",
  worktreePath: "/home/alex/github/remote-ai-manager/.worktrees/my-branch",
  promptCount: 3,
};

describe("InfoDetailsPopover", () => {
  it("hides popover content until the trigger is activated", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    expect(screen.queryByText("Conversation ID")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("Conversation ID")).toBeTruthy();
  });

  it("renders the Claude session ref value", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("sess_abc123xyz")).toBeTruthy();
  });

  it("renders the Codex thread id value", () => {
    render(
      <InfoDetailsPopover
        {...baseProps}
        backendRef={{ backend: "codex", threadId: "thread_xyz789" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("thread_xyz789")).toBeTruthy();
  });

  it("renders an em-dash when backendRef is null", () => {
    render(<InfoDetailsPopover {...baseProps} backendRef={null} />);
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("\u2014")).toBeTruthy();
  });

  it("writes the conversation id to the clipboard when its copy button is activated", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    fireEvent.click(
      screen.getByRole("button", { name: /copy conversation id/i }),
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "c3e2c1cc-abcd-1234-5678-abcdef012345",
    );
  });

  it("writes the full worktree path (not the shortened display) to the clipboard", () => {
    render(<InfoDetailsPopover {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy worktree/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      baseProps.worktreePath,
    );
  });

  it("invokes onCopyContext and renders the Copy context button when provided", () => {
    const onCopyContext = vi.fn().mockReturnValue(true);
    render(<InfoDetailsPopover {...baseProps} onCopyContext={onCopyContext} />);
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    fireEvent.click(screen.getByRole("button", { name: /copy context/i }));
    expect(onCopyContext).toHaveBeenCalledTimes(1);
  });

  it("closes when an outside click occurs after pinning", () => {
    render(
      <div>
        <InfoDetailsPopover {...baseProps} />
        <div data-testid="outside">outside</div>
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: /session details/i }));
    expect(screen.getByText("Conversation ID")).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByText("Conversation ID")).toBeNull();
  });
});
