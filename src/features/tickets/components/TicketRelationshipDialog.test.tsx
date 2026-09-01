// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TicketDetail, TicketListItem } from "@/lib/tickets/schemas";
import TicketRelationshipDialog from "./TicketRelationshipDialog";

const TICKETS: TicketListItem[] = [
  ticket("self", "command-center", 12, "Current ticket", "in_progress"),
  ticket(
    "local-active",
    "command-center",
    7,
    "Local cache work",
    "in_progress",
  ),
  ticket("local-finished", "command-center", 3, "Finished local work", "done"),
  ticket("cross", "dashboard", 4, "Cross-project prerequisite", "not_started"),
];

function ticket(
  id: string,
  projectName: string,
  number: number,
  title: string,
  status: TicketListItem["status"],
): TicketListItem {
  return {
    id,
    projectPath: `/repos/${projectName}`,
    projectName,
    number,
    title,
    workType: "feature",
    status,
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: `2026-08-30T10:00:0${number % 10}.000Z`,
  };
}

function detail(projectName: string, number: number): TicketDetail {
  return {
    id: `${projectName}-${number}`,
    projectPath: `/repos/${projectName}`,
    projectName,
    number,
    title: "Ticket",
    description: "",
    workType: "feature",
    status: "not_started",
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T11:00:00.000Z",
  };
}

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open relationship dialog
      </button>
      <TicketRelationshipDialog
        projectName="command-center"
        number={12}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

function installFetch(options: { addError?: string } = {}) {
  const requests: Array<{ method: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      const method = init?.method ?? "GET";
      if (method === "GET" && url.pathname === "/api/tickets") {
        return Response.json(TICKETS);
      }
      if (method === "POST" && url.pathname.endsWith("/relationships")) {
        const body = JSON.parse(String(init?.body));
        requests.push({ method, body });
        if (options.addError !== undefined) {
          return Response.json({ error: options.addError }, { status: 409 });
        }
        return Response.json({
          relationship: {
            id: "relationship-1",
            role: body.role,
            otherTicket: {
              id: "local-active",
              projectName: body.target.projectName,
              number: body.target.number,
              title: "Local cache work",
              status: "in_progress",
            },
            description: body.description,
            createdAt: "2026-08-30T11:00:00.000Z",
            updatedAt: "2026-08-30T11:00:00.000Z",
          },
          tickets: [
            detail("command-center", 12),
            detail(body.target.projectName, body.target.number),
          ],
        });
      }
      if (method === "GET" && url.pathname.endsWith("/relationships")) {
        return Response.json({ items: [], total: 0, nextCursor: null });
      }
      return Response.json(detail("command-center", 12));
    },
  );
  return requests;
}

function renderHarness() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <Harness />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketRelationshipDialog", () => {
  it("supports keyboard selection, excludes self, ranks local tickets first, and includes finished tickets", async () => {
    const requests = installFetch();
    renderHarness();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open relationship dialog" }),
    );

    const input = await screen.findByRole("combobox", { name: "Ticket" });
    await user.click(input);
    const listbox = await screen.findByRole("listbox", { name: "Tickets" });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      expect.stringContaining("command-center#7"),
      expect.stringContaining("command-center#3"),
      expect.stringContaining("dashboard#4"),
    ]);
    expect(within(listbox).queryByText(/command-center#12/)).toBeNull();
    expect(
      within(listbox).getByText(/Finished local work/),
    ).toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("command-center#7 · Local cache work");
    await user.type(
      screen.getByRole("textbox", { name: "Rationale" }),
      "Needed for **cache ordering**.",
    );
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body).toEqual({
      target: { projectName: "command-center", number: 7 },
      role: "related",
      description: "Needed for **cache ordering**.",
    });
  });

  it("filters parent and child candidates to the current project", async () => {
    installFetch();
    renderHarness();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open relationship dialog" }),
    );

    await user.click(await screen.findByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Parent" }));
    await user.click(screen.getByRole("combobox", { name: "Ticket" }));

    const listbox = await screen.findByRole("listbox", { name: "Tickets" });
    expect(within(listbox).getByText(/command-center#7/)).toBeInTheDocument();
    expect(within(listbox).getByText(/command-center#3/)).toBeInTheDocument();
    expect(within(listbox).queryByText(/dashboard#4/)).toBeNull();
  });

  it("returns focus to its opener after cancellation", async () => {
    installFetch();
    renderHarness();
    const user = userEvent.setup();
    const opener = screen.getByRole("button", {
      name: "Open relationship dialog",
    });
    await user.click(opener);
    await user.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps the dialog open and displays the server refusal", async () => {
    installFetch({ addError: "That dependency would create a cycle." });
    renderHarness();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: "Open relationship dialog" }),
    );
    const input = await screen.findByRole("combobox", { name: "Ticket" });
    await user.click(input);
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "create a cycle",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(input).toHaveValue("command-center#7 · Local cache work");
  });
});
