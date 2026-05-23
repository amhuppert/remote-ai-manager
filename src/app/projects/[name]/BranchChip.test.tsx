// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BranchChip from "./BranchChip";

describe("BranchChip", () => {
  it("renders the branch name", () => {
    render(<BranchChip branch="cc/feature-x" />);
    expect(screen.getByText("cc/feature-x")).toBeInTheDocument();
  });

  it("copies the branch via injected writer and flips to check icon", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    render(<BranchChip branch="cc/copy-me" writeToClipboard={writer} />);
    const btn = screen.getByRole("button", { name: "Copy branch name" });
    fireEvent.click(btn);
    expect(writer).toHaveBeenCalledWith("cc/copy-me");
    await waitFor(() => {
      expect(btn.className).toContain("copied");
    });
  });

  it("reverts to copy icon after the feedback window", async () => {
    vi.useFakeTimers();
    const writer = vi.fn().mockResolvedValue(undefined);
    render(<BranchChip branch="cc/copy-me" writeToClipboard={writer} />);
    const btn = screen.getByRole("button", { name: "Copy branch name" });
    fireEvent.click(btn);
    await vi.waitFor(() => expect(btn.className).toContain("copied"));
    vi.advanceTimersByTime(1300);
    await vi.waitFor(() => expect(btn.className).not.toContain("copied"));
    vi.useRealTimers();
  });

  it("stops click propagation so the parent row is not triggered", () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <BranchChip branch="cc/x" writeToClipboard={() => Promise.resolve()} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name" }));
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("does not flip to check when the writer rejects", async () => {
    const writer = vi.fn().mockRejectedValue(new Error("no clipboard"));
    render(<BranchChip branch="cc/x" writeToClipboard={writer} />);
    const btn = screen.getByRole("button", { name: "Copy branch name" });
    fireEvent.click(btn);
    // Microtask flush.
    await Promise.resolve();
    expect(btn.className).not.toContain("copied");
  });
});
