// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import DiffSlideover from "./DiffSlideover";

afterEach(cleanup);

function renderOpen(onClose = vi.fn()) {
  render(
    <DiffSlideover open onClose={onClose} projectName="cc-app">
      <div>diff body</div>
    </DiffSlideover>,
  );
  return onClose;
}

describe("DiffSlideover", () => {
  it("mounts the hosted diff and a labelled dialog when open", () => {
    renderOpen();
    expect(
      screen.getByRole("dialog", { name: "Main worktree diff" }),
    ).toBeInTheDocument();
    expect(screen.getByText("diff body")).toBeInTheDocument();
    expect(screen.getByText(/cc-app · main · worktree/)).toBeInTheDocument();
  });

  it("renders nothing when closed", () => {
    render(
      <DiffSlideover open={false} onClose={vi.fn()}>
        <div>diff body</div>
      </DiffSlideover>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("diff body")).toBeNull();
  });

  it("dismisses on the close button, Escape, and a scrim click", () => {
    const onClose = renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    fireEvent.keyDown(document, { key: "Escape" });
    // The scrim is the dialog's parent overlay; mousedown on it dismisses.
    fireEvent.mouseDown(screen.getByRole("dialog").parentElement!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("does not dismiss on a mousedown inside the panel", () => {
    const onClose = renderOpen();
    fireEvent.mouseDown(screen.getByText("diff body"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
