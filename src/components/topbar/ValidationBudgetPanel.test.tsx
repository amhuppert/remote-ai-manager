// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { buildValidationBudgetView } from "@/lib/validation/budget-view";
import type { ValidationBudgetResponse } from "@/lib/validation/api-schemas";

import { ValidationBudgetPanel } from "./ValidationBudgetPanel";

function viewFrom(response: ValidationBudgetResponse) {
  const view = buildValidationBudgetView(response);
  if (view === null) throw new Error("expected a renderable budget view");
  return view;
}

const DESIGN_SCENARIO: ValidationBudgetResponse = {
  available: true,
  capacity: { limit: 8, inUse: 7, queueDepth: 9 },
  runs: [
    {
      runId: "r-test",
      commandName: "test",
      status: "running",
      cost: 4,
      projectName: "command-center",
      sessionName: "csm/budget",
      conversationId: "conv-1",
      position: null,
    },
    {
      runId: "r-lint",
      commandName: "lint",
      status: "running",
      cost: 2,
      projectName: "taskgarden",
      sessionName: "csm/spec-import",
      conversationId: "conv-2",
      position: null,
    },
    {
      runId: "r-format",
      commandName: "format",
      status: "running",
      cost: 1,
      projectName: "command-center",
      sessionName: null,
      conversationId: null,
      position: null,
    },
    ...Array.from({ length: 9 }, (_, index) => ({
      runId: `q-${index}`,
      commandName: "test",
      status: "queued" as const,
      cost: 4,
      projectName: "taskgarden",
      sessionName: "csm/spec-import",
      conversationId: `queued-conv-${index}`,
      position: index,
    })),
  ],
};

describe("ValidationBudgetPanel", () => {
  it("states the totals and what is left", () => {
    render(<ValidationBudgetPanel view={viewFrom(DESIGN_SCENARIO)} />);

    expect(screen.getByText("7 of 8 units")).toBeInTheDocument();
    expect(
      screen.getByText("1 unit free — next up needs 4u"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("4 + 2 + 1 allocated · 1 free of 8"),
    ).toBeInTheDocument();
  });

  it("links a run to the conversation holding the budget", () => {
    render(<ValidationBudgetPanel view={viewFrom(DESIGN_SCENARIO)} />);

    const link = screen.getByRole("link", {
      name: /test.*command-center.*4u/s,
    });
    expect(link).toHaveAttribute("href", "/conversations?c=conv-1");
  });

  it("renders a system-owned run with no owner as a plain row", () => {
    render(<ValidationBudgetPanel view={viewFrom(DESIGN_SCENARIO)} />);

    // `format` names neither a session nor a conversation, so it degrades to
    // its project rather than becoming a dead link.
    const link = screen.getByRole("link", { name: /format/s });
    expect(link).toHaveAttribute("href", "/projects/command-center");
  });

  it("previews the head of the queue and counts the rest", () => {
    render(<ValidationBudgetPanel view={viewFrom(DESIGN_SCENARIO)} />);

    expect(screen.getByText("9 queued")).toBeInTheDocument();
    expect(screen.getByText("+6 more queued")).toBeInTheDocument();
  });

  it("omits the queue section entirely when nothing is waiting", () => {
    const view = viewFrom({
      available: true,
      capacity: { limit: 8, inUse: 4, queueDepth: 0 },
      runs: [
        {
          runId: "r-test",
          commandName: "test",
          status: "running",
          cost: 4,
          projectName: "command-center",
          sessionName: "csm/budget",
          conversationId: "conv-1",
          position: null,
        },
      ],
    });

    render(<ValidationBudgetPanel view={view} />);

    expect(screen.queryByText("Next up")).not.toBeInTheDocument();
    expect(screen.getByText("4 units free · queue empty")).toBeInTheDocument();
  });

  it("labels only the allocation segments wide enough to carry a name", () => {
    render(<ValidationBudgetPanel view={viewFrom(DESIGN_SCENARIO)} />);

    const bar = screen.getByRole("img", {
      name: "4 + 2 + 1 allocated · 1 free of 8",
    });
    // 4u "test" and 2u "lint" are labelled; the 1u run and the free unit are
    // too narrow to seat a name.
    expect(
      within(bar)
        .getAllByText(/\S/)
        .map((n) => n.textContent),
    ).toEqual(["test", "lint"]);
  });
});
