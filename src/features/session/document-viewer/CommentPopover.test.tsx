// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CommentPopover from "./CommentPopover";

function setup() {
  const onQueue = vi.fn();
  const onSend = vi.fn();
  const onCancel = vi.fn();
  render(
    <CommentPopover
      quote="agent-produced markdown"
      onQueue={onQueue}
      onSend={onSend}
      onCancel={onCancel}
    />,
  );
  return { onQueue, onSend, onCancel };
}

describe("CommentPopover", () => {
  it("shows the selected passage preview", () => {
    setup();
    expect(screen.getByText(/agent-produced markdown/)).toBeInTheDocument();
  });

  it("keeps both actions disabled while the note is empty or whitespace", async () => {
    const user = userEvent.setup();
    setup();
    const queue = screen.getByRole("button", { name: /add comment/i });
    const send = screen.getByRole("button", { name: /add & send/i });
    expect(queue).toBeDisabled();
    expect(send).toBeDisabled();

    const note = screen.getByRole("textbox");
    await user.type(note, "   ");
    expect(queue).toBeDisabled();
    expect(send).toBeDisabled();

    await user.type(note, "needs detail");
    expect(queue).toBeEnabled();
    expect(send).toBeEnabled();
  });

  it("queues with the trimmed note", async () => {
    const user = userEvent.setup();
    const { onQueue, onSend } = setup();
    await user.type(screen.getByRole("textbox"), "  please clarify  ");
    await user.click(screen.getByRole("button", { name: /add comment/i }));
    expect(onQueue).toHaveBeenCalledWith("please clarify");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("sends immediately with the trimmed note", async () => {
    const user = userEvent.setup();
    const { onSend, onQueue } = setup();
    await user.type(screen.getByRole("textbox"), "fix this");
    await user.click(screen.getByRole("button", { name: /add & send/i }));
    expect(onSend).toHaveBeenCalledWith("fix this");
    expect(onQueue).not.toHaveBeenCalled();
  });

  it("cancels via the cancel button and the Escape key", async () => {
    const user = userEvent.setup();
    const { onCancel } = setup();
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalledTimes(2);
  });
});
