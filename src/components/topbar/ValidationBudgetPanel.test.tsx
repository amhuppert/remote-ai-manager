// @vitest-environment jsdom
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
      conversationName: "Review validation monitor",
      startedAt: "2026-10-13T15:00:00.000Z",
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
      conversationName: "Review validation monitor",
      startedAt: "2026-10-13T15:00:00.000Z",
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
      conversationName: null,
      startedAt: "2026-10-13T15:00:00.000Z",
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
      conversationName: "Review validation monitor",
      startedAt: null,
      position: index,
    })),
  ],
};

function scenarioRun(index: number) {
  const run = DESIGN_SCENARIO.runs[index];
  if (!run) throw new Error(`missing scenario run ${index}`);
  return run;
}

describe("ValidationBudgetPanel", () => {
  afterEach(() => vi.useRealTimers());

  it("shows the owner, actual start time, and elapsed execution time without a refetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T15:05:07.000Z"));
    const startedAt = "2026-10-13T15:00:00.000Z";
    const response = {
      ...DESIGN_SCENARIO,
      runs: [
        {
          ...scenarioRun(0),
          conversationName: "Review validation monitor",
          startedAt,
        },
      ],
    };
    const { unmount } = render(
      <ValidationBudgetPanel view={viewFrom(response)} />,
    );
    const link = screen.getByRole("link");
    expect(within(link).getByText("csm/budget")).toBeInTheDocument();
    expect(
      within(link).getByText("Review validation monitor"),
    ).toBeInTheDocument();
    expect(within(link).getByText("5m 07s")).toBeInTheDocument();
    const time = link.querySelector("time");
    expect(time).toHaveAttribute("dateTime", startedAt);
    expect(time).toHaveTextContent(
      new Date(startedAt).toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
      }),
    );
    act(() => vi.advanceTimersByTime(2000));
    expect(within(link).getByText("5m 09s")).toBeInTheDocument();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("identifies queued owners without claiming they have started", () => {
    render(
      <ValidationBudgetPanel
        view={viewFrom({
          ...DESIGN_SCENARIO,
          runs: [
            {
              ...scenarioRun(3),
              conversationName: "Queued review",
              startedAt: null,
            },
          ],
        })}
      />,
    );
    const link = screen.getByRole("link");
    expect(within(link).getByText("csm/spec-import")).toBeInTheDocument();
    expect(within(link).getByText("Queued review")).toBeInTheDocument();
    expect(within(link).queryByText(/Started/)).not.toBeInTheDocument();
  });

  it("shows an explicit label for an unnamed conversation", () => {
    render(
      <ValidationBudgetPanel
        view={viewFrom({
          ...DESIGN_SCENARIO,
          runs: [
            {
              ...scenarioRun(0),
              conversationName: "",
              startedAt: null,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("Untitled conversation")).toBeInTheDocument();
    expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
  });

  it.each([
    ["2026-10-13T15:05:07.000Z", "0s"],
    ["2026-10-13T15:06:00.000Z", "0s"],
    ["2026-10-13T14:05:07.000Z", "1h 00m 00s"],
  ])("formats elapsed time from %s as %s", (startedAt, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T15:05:07.000Z"));
    render(
      <ValidationBudgetPanel
        view={viewFrom({
          ...DESIGN_SCENARIO,
          runs: [{ ...scenarioRun(0), startedAt }],
        })}
      />,
    );
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

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
      name: /test.*4u.*csm\/budget.*command-center/s,
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
          conversationName: "Review validation monitor",
          startedAt: "2026-10-13T15:00:00.000Z",
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
