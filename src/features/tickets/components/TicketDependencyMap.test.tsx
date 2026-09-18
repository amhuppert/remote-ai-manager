// @vitest-environment jsdom
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { TicketRelationshipView } from "@/lib/tickets/schemas";
import TicketDependencyMap, {
  type DependencyTicket,
} from "./TicketDependencyMap";

const focus: DependencyTicket = {
  id: "focus",
  projectName: "app",
  number: 12,
  title: "Release the dashboard",
  status: "in_progress",
};

function relationship(
  number: number,
  title: string,
  role: "depends_on" | "blocks",
  status: DependencyTicket["status"] = "not_started",
): TicketRelationshipView {
  return {
    id: `edge-${number}`,
    role,
    otherTicket: {
      id: `ticket-${number}`,
      projectName: "app",
      number,
      title,
      status,
    },
    description: "",
    createdAt: "2026-09-18T10:00:00Z",
    updatedAt: "2026-09-18T10:00:00Z",
  };
}

let api: FetchFixture;
beforeEach(() => {
  api = installFetchFixture();
});
afterEach(() => {
  cleanup();
  api.restore();
});

function page(
  number: number,
  role: "depends_on" | "blocks",
  items: TicketRelationshipView[],
) {
  api.json(
    "GET",
    new RegExp(`/tickets/${number}/relationships\\?[^#]*role=${role}`),
    { items, total: items.length, nextCursor: null },
  );
}

describe("TicketDependencyMap", () => {
  it("separates prerequisites from dependents and offers centered graph and ticket links", async () => {
    page(12, "depends_on", [
      relationship(4, "Prepare the API", "depends_on", "done"),
    ]);
    page(12, "blocks", [
      relationship(18, "Launch to customers", "blocks", "blocked"),
    ]);
    renderWithQuery(<TicketDependencyMap ticket={focus} />);
    const upstream = screen.getByRole("region", { name: "Depends on" });
    const downstream = screen.getByRole("region", { name: "Blocks" });
    expect(await within(upstream).findByText("Prepare the API")).toBeDefined();
    expect(within(upstream).getByText("Done")).toBeDefined();
    expect(
      await within(downstream).findByText("Launch to customers"),
    ).toBeDefined();
    expect(within(downstream).getByText("Blocked")).toBeDefined();
    expect(
      within(upstream)
        .getByRole("link", { name: "Center on app#4" })
        .getAttribute("href"),
    ).toBe("/tickets/app/4/dependencies");
    expect(
      within(upstream)
        .getByRole("link", { name: "Open app#4" })
        .getAttribute("href"),
    ).toBe("/tickets/app/4");
  });

  it("loads transitive prerequisites only when expanded and can collapse them", async () => {
    page(12, "depends_on", [relationship(4, "Prepare the API", "depends_on")]);
    page(12, "blocks", []);
    page(4, "depends_on", [relationship(2, "Define the schema", "depends_on")]);
    renderWithQuery(<TicketDependencyMap ticket={focus} />);
    const expand = await screen.findByRole("button", {
      name: "Expand prerequisites for app#4",
    });
    expect(
      api.requestsTo("GET", "/api/projects/app/tickets/4/relationships"),
    ).toHaveLength(0);
    const user = userEvent.setup();
    await user.click(expand);
    expect(await screen.findByText("Define the schema")).toBeDefined();
    expect(screen.getByText("app#4 depends on")).toBeDefined();
    expect(expand.getAttribute("aria-expanded")).toBe("true");
    await user.click(expand);
    expect(screen.queryByText("Define the schema")).toBeNull();
  });

  it("loads additional relationships explicitly without hiding their count", async () => {
    page(12, "blocks", []);
    api.reply(
      "GET",
      /\/tickets\/12\/relationships\?.*role=depends_on/,
      (request) => ({
        json: request.searchParams.has("cursor")
          ? {
              items: [relationship(5, "Second prerequisite", "depends_on")],
              total: 2,
              nextCursor: null,
            }
          : {
              items: [relationship(4, "First prerequisite", "depends_on")],
              total: 2,
              nextCursor: "next-page",
            },
      }),
    );
    renderWithQuery(<TicketDependencyMap ticket={focus} />);
    await userEvent.setup().click(
      await screen.findByRole("button", {
        name: "Load more prerequisites (1 of 2 shown)",
      }),
    );
    expect(await screen.findByText("Second prerequisite")).toBeDefined();
    expect(screen.getByText("First prerequisite")).toBeDefined();
    expect(
      screen.queryByRole("button", { name: /Load more prerequisites/ }),
    ).toBeNull();
  });

  it("shows independent errors and retries without hiding the other direction", async () => {
    let failed = true;
    api.reply("GET", /\/tickets\/12\/relationships\?.*role=depends_on/, () =>
      failed
        ? { status: 500, json: { error: "Unavailable" } }
        : { json: { items: [], total: 0, nextCursor: null } },
    );
    page(12, "blocks", []);
    renderWithQuery(<TicketDependencyMap ticket={focus} />);
    expect(
      await screen.findByText("No tickets depend on this ticket."),
    ).toBeDefined();
    expect(await screen.findByRole("alert")).toBeDefined();
    failed = false;
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry prerequisites" }));
    expect(await screen.findByText("No prerequisites.")).toBeDefined();
  });
});
