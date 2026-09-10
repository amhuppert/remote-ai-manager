// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import GatesList from "./GatesList";
import type { ExecutionGate } from "@/lib/workflow-graph/execution-gates";

const APPROVAL: ExecutionGate = {
  kind: "approval",
  contextId: "ctx_checkout",
  contextTitle: "Implement checkout",
  detail: "context approval · iteration 2 candidate",
};

const QUESTION: ExecutionGate = {
  kind: "question",
  contextId: "ctx_settings",
  contextTitle: "Settings surface",
  laneKey: "implementer",
  detail: 'parked question · "Should the toggle default to on?"',
};

const JOIN: ExecutionGate = {
  kind: "join",
  joinId: "join_delivery_1",
  contextId: "ctx_checkout",
  contextTitle: "Implement",
  detail:
    "join conflict · merging into delivery · Implement blocked: both wrote the timeout branch",
};

describe("GatesList", () => {
  it("counts the open gates and says each row names its own context", () => {
    render(<GatesList gates={[APPROVAL, QUESTION]} onOpenGate={vi.fn()} />);

    const list = screen.getByTestId("execution-gates-list");
    expect(within(list).getByTestId("gates-count")).toHaveTextContent("2");
    expect(list).toHaveTextContent(
      "there is no single global gate — each row names its context",
    );
  });

  it("names the context and the wait on every row", () => {
    render(<GatesList gates={[APPROVAL, QUESTION]} onOpenGate={vi.fn()} />);

    const rows = screen.getAllByTestId("execution-gate-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Implement checkout");
    expect(rows[0]).toHaveTextContent(
      "context approval · iteration 2 candidate",
    );
    expect(rows[1]).toHaveTextContent("Settings surface");
    expect(rows[1]).toHaveTextContent(
      'parked question · "Should the toggle default to on?"',
    );
  });

  it("opens the context a gate belongs to", () => {
    const onOpenGate = vi.fn();
    render(<GatesList gates={[APPROVAL, QUESTION]} onOpenGate={onOpenGate} />);

    fireEvent.click(screen.getAllByTestId("execution-gate-row")[1]!);

    expect(onOpenGate).toHaveBeenCalledWith(QUESTION);
  });

  it("offers each row as a real focusable control", () => {
    render(<GatesList gates={[APPROVAL]} onOpenGate={vi.fn()} />);

    const row = screen.getByRole("button", {
      name: /Implement checkout/,
    });
    row.focus();
    expect(row).toHaveFocus();
  });

  it("opens the blocked member of a join conflict", () => {
    const onOpenGate = vi.fn();
    render(<GatesList gates={[JOIN]} onOpenGate={onOpenGate} />);

    const row = screen.getByTestId("execution-gate-row");
    expect(row).toHaveAttribute("data-gate-kind", "join");
    expect(row).toHaveTextContent(
      "join conflict · merging into delivery · Implement blocked",
    );

    fireEvent.click(row);
    expect(onOpenGate).toHaveBeenCalledWith(JOIN);
  });

  // No destination means no control: a button that navigates nowhere is worse
  // than a row that simply states the conflict.
  it("states an unattributable join without offering a dead control", () => {
    render(
      <GatesList
        gates={[{ ...JOIN, contextId: null, contextTitle: "lane-implement" }]}
        onOpenGate={vi.fn()}
      />,
    );

    const row = screen.getByTestId("execution-gate-row");
    expect(row).toHaveTextContent("join conflict");
    expect(row.tagName).not.toBe("BUTTON");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("says nothing is waiting when no gate is open", () => {
    render(<GatesList gates={[]} onOpenGate={vi.fn()} />);

    expect(screen.queryByTestId("execution-gate-row")).not.toBeInTheDocument();
    expect(
      screen.getByText("Nothing on this run is waiting on you."),
    ).toBeInTheDocument();
  });
});
