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

  it("toggles between the transcript and the diff surface", () => {
    renderPane();
    expect(screen.getByText("transcript")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Diff / review" }));
    expect(screen.getByText("diff")).toBeInTheDocument();
  });
});
