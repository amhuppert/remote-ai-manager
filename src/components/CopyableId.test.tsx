// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import CopyableId from "./CopyableId";

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CopyableId", () => {
  it("shows the truncated display but copies the full value", () => {
    render(<CopyableId label="ID" value="0123456789abcdef" truncateAt={8} />);
    expect(screen.getByText("01234567…")).toBeInTheDocument();
    fireEvent.click(screen.getByText("01234567…"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "0123456789abcdef",
    );
  });

  it("renders an explicit displayValue while copying the underlying value", () => {
    render(
      <CopyableId
        value="/full/worktree/path"
        displayValue="path"
        ariaLabel="Copy Worktree"
      />,
    );
    expect(screen.getByText("path")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy Worktree" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      "/full/worktree/path",
    );
  });

  it("flips to the copied state then reverts after the feedback window", async () => {
    vi.useFakeTimers();
    render(<CopyableId value="abc" ariaLabel="Copy" />);
    const btn = screen.getByRole("button", { name: "Copy" });
    fireEvent.click(btn);
    await vi.waitFor(() => expect(btn.className).toContain("copied"));
    vi.advanceTimersByTime(1600);
    await vi.waitFor(() => expect(btn.className).not.toContain("copied"));
  });

  it("stops click propagation so an enclosing handler is not triggered", () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <CopyableId value="abc" ariaLabel="Copy" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
