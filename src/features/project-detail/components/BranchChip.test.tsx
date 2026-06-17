// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import BranchChip from "./BranchChip";

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("BranchChip", () => {
  it("renders the branch name", () => {
    render(<BranchChip branch="cc/feature-x" />);
    expect(screen.getByText("cc/feature-x")).toBeInTheDocument();
  });

  it("copies the branch name via the Copy branch name control", () => {
    render(<BranchChip branch="cc/copy-me" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("cc/copy-me");
  });

  it("stops click propagation so the parent row is not triggered", () => {
    const onParentClick = vi.fn();
    render(
      <div onClick={onParentClick}>
        <BranchChip branch="cc/x" />
      </div>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy branch name" }));
    expect(onParentClick).not.toHaveBeenCalled();
  });
});
