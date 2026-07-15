// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TicketListItem } from "@/lib/tickets/schemas";
import TicketBoard from "./TicketBoard";
import TicketList from "./TicketList";

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

function ticket(id: string, number: number, title: string): TicketListItem {
  return {
    id,
    projectPath: "/repos/project",
    projectName: "project",
    number,
    title,
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:00:00.000Z",
  };
}

const FIRST = ticket("ticket-1", 1, "First ticket");
const SECOND = ticket("ticket-2", 2, "Second ticket");

function Providers({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ticket live-update motion", () => {
  it("washes new list rows and retains removed rows for the 150ms collapse", () => {
    vi.useFakeTimers();
    const view = render(
      <TicketList items={[FIRST]} hasAnyTickets onClearFilters={() => {}} />,
      { wrapper: Providers },
    );

    view.rerender(
      <TicketList
        items={[FIRST, SECOND]}
        hasAnyTickets
        onClearFilters={() => {}}
      />,
    );
    expect(
      document.querySelector('[data-ticket-title="Second ticket"]')?.className,
    ).toContain("animate-tk-sse-in");
    expect(
      document.querySelector('[data-ticket-title="Second ticket"]')?.className,
    ).toContain("motion-reduce:animate-none");

    view.rerender(
      <TicketList items={[SECOND]} hasAnyTickets onClearFilters={() => {}} />,
    );
    expect(
      document.querySelector('[data-ticket-title="First ticket"]')?.className,
    ).toContain("animate-tk-sse-out");
    expect(
      document.querySelector('[data-ticket-title="First ticket"]')?.className,
    ).toContain("motion-reduce:animate-none");

    act(() => vi.advanceTimersByTime(150));
    expect(
      document.querySelector('[data-ticket-title="First ticket"]'),
    ).toBeNull();
  });

  it("applies the same enter and collapse-out motion to board cards", () => {
    vi.useFakeTimers();
    const view = render(<TicketBoard items={[FIRST]} />, {
      wrapper: Providers,
    });

    view.rerender(<TicketBoard items={[FIRST, SECOND]} />);
    expect(
      document.querySelector('[data-ticket-card="project#2"]')?.className,
    ).toContain("animate-tk-sse-in");
    expect(
      document.querySelector('[data-ticket-card="project#2"]')?.className,
    ).toContain("motion-reduce:animate-none");

    view.rerender(<TicketBoard items={[SECOND]} />);
    expect(
      document.querySelector('[data-ticket-card="project#1"]')?.className,
    ).toContain("animate-tk-sse-out");
    expect(
      document.querySelector('[data-ticket-card="project#1"]')?.className,
    ).toContain("motion-reduce:animate-none");

    act(() => vi.advanceTimersByTime(150));
    expect(document.querySelector('[data-ticket-card="project#1"]')).toBeNull();
  });

  it("stops active-session pulses when reduced motion is requested", () => {
    const active = { ...FIRST, activeSessionName: "ticket-session" };
    const list = render(
      <TicketList items={[active]} hasAnyTickets onClearFilters={() => {}} />,
      { wrapper: Providers },
    );

    expect(list.container.querySelector('[class*="pulse-dot"]')).toHaveClass(
      "motion-reduce:[animation:none]",
    );
    const activeSessionChip = screen
      .getByText("ticket-session")
      .closest("[data-tone]");
    expect(activeSessionChip).toHaveAttribute("data-appearance", "solid");
    expect(activeSessionChip).toHaveAttribute("data-tone", "neutral");
    list.unmount();

    const board = render(<TicketBoard items={[active]} />, {
      wrapper: Providers,
    });
    expect(board.container.querySelector('[class*="pulse-dot"]')).toHaveClass(
      "motion-reduce:[animation:none]",
    );
  });
});
