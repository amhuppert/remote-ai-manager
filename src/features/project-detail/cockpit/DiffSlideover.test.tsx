// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import DiffSlideover from "./DiffSlideover";

// The slide-over composes ui/Dialog (Radix) — it locks scroll / manages focus on
// open, and jsdom implements none of the pointer-capture APIs it reaches for.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

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

  it("dismisses via the close button", () => {
    const onClose = renderOpen();
    fireEvent.click(screen.getByRole("button", { name: "Close diff" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("dismisses via Escape (Radix owns dismissal)", () => {
    const onClose = renderOpen();
    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Escape",
      code: "Escape",
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss on an interaction inside the panel", () => {
    const onClose = renderOpen();
    fireEvent.mouseDown(screen.getByText("diff body"));
    fireEvent.click(screen.getByText("diff body"));
    expect(onClose).not.toHaveBeenCalled();
  });
});
