// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  createTicketMentionPopup,
  type TicketMentionPopupHandle,
} from "./PromptEditorTicketMentionPopup";

function ticket(
  overrides: Partial<TicketListItem> & { id: string },
): TicketListItem {
  return {
    id: overrides.id,
    projectPath: overrides.projectPath ?? "/repos/alpha",
    projectName: overrides.projectName ?? "alpha",
    number: overrides.number ?? 1,
    title: overrides.title ?? "Ticket title",
    workType: overrides.workType ?? "feature",
    status: overrides.status ?? "not_started",
    attachmentCount: overrides.attachmentCount ?? 0,
    activeSessionName: overrides.activeSessionName ?? null,
    createdAt: overrides.createdAt ?? "2026-07-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  };
}

function renderPopup(
  items: TicketListItem[],
  query = "",
  onSelect = vi.fn(),
  onClose = vi.fn(),
) {
  const Popup = createTicketMentionPopup({
    useTickets: () => ({
      data: items,
      isLoading: false,
      isError: false,
      error: null,
    }),
  });
  const ref = createRef<TicketMentionPopupHandle>();
  render(
    <Popup
      ref={ref}
      query={query}
      currentProjectName="alpha"
      onSelect={onSelect}
      onClose={onClose}
    />,
  );
  return { ref, onSelect, onClose };
}

describe("PromptEditorTicketMentionPopup", () => {
  it("filters ticket results and prioritizes the current project", () => {
    renderPopup(
      [
        ticket({
          id: "other",
          projectName: "beta",
          title: "Authentication cleanup",
          number: 2,
        }),
        ticket({
          id: "current",
          projectName: "alpha",
          title: "Authentication hardening",
          number: 3,
        }),
        ticket({ id: "hidden", title: "Unrelated", number: 4 }),
      ],
      "auth",
    );

    const options = screen.getAllByRole("option");
    expect(options[0]).toHaveTextContent("alpha#3");
    expect(options[1]).toHaveTextContent("beta#2");
    expect(screen.queryByText("Unrelated")).not.toBeInTheDocument();
  });

  it("ArrowDown and Enter select canonical ticket mention attributes", () => {
    const { ref, onSelect } = renderPopup([
      ticket({ id: "first", number: 1, title: "First" }),
      ticket({ id: "second", projectName: "beta", number: 9, title: "Second" }),
    ]);

    act(() => {
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
      ref.current?.handleKeyDown(
        new KeyboardEvent("keydown", { key: "Enter" }),
      );
    });

    expect(onSelect).toHaveBeenCalledWith({
      projectName: "beta",
      ticketNumber: "9",
      identifier: "beta#9",
      title: "Second",
    });
  });

  it("Escape closes and consumes the popup event", () => {
    const { ref, onClose } = renderPopup([ticket({ id: "first" })]);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
      bubbles: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    expect(ref.current?.handleKeyDown(event)).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(preventDefault).toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalled();
  });
});
