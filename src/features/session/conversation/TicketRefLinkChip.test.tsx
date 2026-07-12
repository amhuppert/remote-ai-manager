// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TicketRefLinkChip from "./TicketRefLinkChip";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";

function makeAttrs(overrides: Partial<TicketRefAttrs> = {}): TicketRefAttrs {
  return {
    "project-name": "command-center",
    "ticket-number": "12",
    identifier: "command-center#12",
    title: "Add durable ticket context",
    "read-command": "cctl ticket get command-center#12",
    ...overrides,
  };
}

describe("TicketRefLinkChip", () => {
  it("renders an anchor navigating to the ticket detail route", () => {
    render(<TicketRefLinkChip attrs={makeAttrs()} />);

    const anchor = screen.getByRole("link");
    expect(anchor).toHaveAttribute("href", "/tickets/command-center/12");
  });

  it("URL-encodes a project name containing special characters", () => {
    render(
      <TicketRefLinkChip
        attrs={makeAttrs({ "project-name": "my app", identifier: "my app#3" })}
      />,
    );

    expect(screen.getByRole("link")).toHaveAttribute(
      "href",
      "/tickets/my%20app/12",
    );
  });

  it("shows the identifier and the ticket title", () => {
    render(<TicketRefLinkChip attrs={makeAttrs()} />);

    const anchor = screen.getByRole("link");
    expect(anchor.textContent).toContain("command-center#12");
    expect(anchor.textContent).toContain("Add durable ticket context");
  });

  it("truncates a long title in the label but keeps it whole in the tooltip", () => {
    const longTitle =
      "Investigate intermittent flaky test in the orchestrator integration suite";
    render(<TicketRefLinkChip attrs={makeAttrs({ title: longTitle })} />);

    const anchor = screen.getByRole("link");
    expect(anchor.textContent).not.toContain(longTitle);
    expect(anchor.textContent).toContain("…");
    expect(anchor).toHaveAttribute("title", longTitle);
  });

  it("has no remove control", () => {
    render(<TicketRefLinkChip attrs={makeAttrs()} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
