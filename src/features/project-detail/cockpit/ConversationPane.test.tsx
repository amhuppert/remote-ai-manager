// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import ConversationPane from "./ConversationPane";

afterEach(cleanup);

function renderPane(
  props?: Partial<React.ComponentProps<typeof ConversationPane>>,
) {
  return render(
    <ConversationPane
      agentBackend="claude"
      transcript={<div>transcript</div>}
      composer={<div>composer</div>}
      diffSurface={<div>diff</div>}
      {...props}
    />,
  );
}

describe("ConversationPane", () => {
  it("identifies the execution context as main · worktree", () => {
    renderPane();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("worktree")).toBeInTheDocument();
  });

  it("surfaces a running status badge in the header", () => {
    renderPane({ status: "running" });
    const badge = screen.getByText("Running");
    expect(badge).toHaveAttribute("data-status", "running");
  });

  it("surfaces a waiting-for-input status as an awaiting badge", () => {
    renderPane({ status: "waiting_for_input" });
    const badge = screen.getByText("Waiting for input");
    expect(badge).toHaveAttribute("data-status", "awaiting");
  });

  it("renders no status badge for the resting 'new' status", () => {
    renderPane({ status: "new" });
    expect(screen.queryByText("Running")).toBeNull();
    expect(screen.queryByText(/Awaiting|Waiting/)).toBeNull();
  });

  it("opens the read-only diff slide-over from the main · worktree chip", () => {
    renderPane();
    expect(screen.getByText("transcript")).toBeInTheDocument();
    // The diff is not mounted until the chip is clicked.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /worktree/i }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("diff")).toBeInTheDocument();
    // The transcript stays mounted underneath — the diff is an overlay.
    expect(screen.getByText("transcript")).toBeInTheDocument();
  });

  it("shows the live +/− stat on the chip when the worktree is dirty", () => {
    renderPane({ diffStat: { additions: 12, deletions: 3, fileCount: 2 } });
    const chip = screen.getByRole("button", { name: /worktree/i });
    expect(chip).toHaveTextContent("+12");
    expect(chip).toHaveTextContent("−3");
  });

  it("renders worktree context as plain text (no chip) without a diff surface", () => {
    renderPane({ diffSurface: undefined });
    expect(screen.getByText("worktree")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /worktree/i })).toBeNull();
  });
});
