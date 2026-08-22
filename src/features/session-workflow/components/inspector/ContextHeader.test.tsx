// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import ContextHeader from "./ContextHeader";
import type { ContextHeaderView } from "./context-header-model";

function view(overrides: Partial<ContextHeaderView> = {}): ContextHeaderView {
  return {
    contextId: "context-plan",
    title: "Plan the migration",
    status: { key: "running", label: "Running", live: true },
    metaParts: [
      "context-plan",
      "lane backend",
      "worktree src/lib/**",
      "iteration 2",
    ],
    loopLabel: null,
    ...overrides,
  };
}

describe("ContextHeader", () => {
  it("renders the title, the status pill and the meta line in order", () => {
    render(<ContextHeader view={view()} onBack={vi.fn()} />);

    expect(screen.getByText("Plan the migration")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    // The `·` separators are decorative spans laid out with a gap, so the
    // accessible text runs the segments together.
    expect(screen.getByTestId("context-header-meta")).toHaveTextContent(
      "context-plan·lane backend·worktree src/lib/**·iteration 2",
    );
  });

  it("shows the loop pass only while the context sits in a loop", () => {
    const { rerender } = render(
      <ContextHeader view={view()} onBack={vi.fn()} />,
    );
    expect(screen.queryByTestId("context-header-loop")).not.toBeInTheDocument();

    rerender(
      <ContextHeader
        view={view({ loopLabel: "pass 2 of 3" })}
        onBack={vi.fn()}
      />,
    );
    expect(screen.getByTestId("context-header-loop")).toHaveTextContent(
      "pass 2 of 3",
    );
  });

  it("returns to the overview from a real focusable control", () => {
    const onBack = vi.fn();
    render(<ContextHeader view={view()} onBack={onBack} />);

    const back = screen.getByRole("button", { name: "Back to overview" });
    fireEvent.click(back);

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("hosts the context-scoped controls the host owns", () => {
    render(
      <ContextHeader
        view={view()}
        onBack={vi.fn()}
        trailing={<button type="button">Reset Context</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Reset Context" }),
    ).toBeInTheDocument();
  });
});
