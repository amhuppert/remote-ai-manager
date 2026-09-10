// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { cleanup, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithQuery, createTestQueryClient } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import TicketRefLinkChip from "./TicketRefLinkChip";
import type { TicketRefAttrs } from "@/lib/tickets/schemas";

const attrs: TicketRefAttrs = {
  "project-name": "command-center",
  "ticket-number": "12",
  identifier: "command-center#12",
  title: "Add durable ticket context",
  "read-command": "cctl ticket get command-center#12",
};
let api: FetchFixture;
let client: ReturnType<typeof createTestQueryClient>;
beforeEach(() => {
  client = createTestQueryClient();
  api = installFetchFixture();
  api.json("POST", "/api/live-references", {
    results: [
      {
        target: { kind: "ticket", projectName: "command-center", id: "12" },
        checkedAt: "2026-09-10T04:00:00Z",
        unavailableReason: null,
        summary: {
          title: "Current title",
          identity: "command-center#12",
          status: "Done",
          tone: "green",
          href: "/tickets/command-center/12",
          readCommand: attrs["read-command"],
          details: [],
          attentionCount: 0,
        },
      },
    ],
  });
});
afterEach(() => {
  cleanup();
  client.clear();
  api.restore();
});

describe("TicketRefLinkChip", () => {
  it("shows the captured title and identity while resolving current state", () => {
    renderWithQuery(<TicketRefLinkChip attrs={attrs} />, client);
    expect(screen.getByText(attrs.title)).toBeInTheDocument();
    expect(screen.getByText(attrs.identifier)).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Remove/ }),
    ).not.toBeInTheDocument();
  });
  it("opens a preview with current state and a separate navigation action", async () => {
    renderWithQuery(<TicketRefLinkChip attrs={attrs} />, client);
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Current title/ }),
    );
    expect(screen.getByRole("link", { name: "Open" })).toHaveAttribute(
      "href",
      "/tickets/command-center/12",
    );
    expect(api.requestsTo("POST", "/api/live-references")[0]?.jsonBody).toEqual(
      {
        targets: [{ kind: "ticket", projectName: "command-center", id: "12" }],
      },
    );
    await user.click(screen.getByRole("button", { name: "Copy reference" }));
    expect(await navigator.clipboard.readText()).toContain(
      'ticket-number="12"',
    );
  });
  it("keeps the full title available to assistive technology", () => {
    const title = "A very long title ".repeat(20).trim();
    renderWithQuery(<TicketRefLinkChip attrs={{ ...attrs, title }} />, client);
    expect(
      screen.getByRole("button", { name: `${title} · Loading` }),
    ).toBeInTheDocument();
  });
});
