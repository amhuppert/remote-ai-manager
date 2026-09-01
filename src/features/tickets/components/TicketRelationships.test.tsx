// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  TicketDetail,
  TicketListItem,
  TicketRelationshipRole,
  TicketRelationshipView,
} from "@/lib/tickets/schemas";
import TicketRelationships from "./TicketRelationships";

function relationship(
  id: string,
  role: TicketRelationshipRole,
  projectName: string,
  number: number,
  description = "",
): TicketRelationshipView {
  return {
    id,
    role,
    otherTicket: {
      id: `${projectName}-${number}`,
      projectName,
      number,
      title: `${role.replaceAll("_", " ")} ticket`,
      status: role === "blocks" ? "blocked" : "in_progress",
    },
    description,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T11:00:00.000Z",
  };
}

const RELATIONSHIPS = [
  relationship(
    "related-1",
    "related",
    "dashboard",
    4,
    "Shared **event ordering** rationale.",
  ),
  relationship("child-1", "child", "command-center", 14),
  relationship("parent-1", "parent", "command-center", 2),
  relationship("blocks-1", "blocks", "dashboard", 9),
  relationship("depends-1", "depends_on", "platform", 8),
];

const CANDIDATES: TicketListItem[] = [
  {
    id: "self",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Current ticket",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  },
  {
    id: "new-parent",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 5,
    title: "Replacement parent",
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  },
];

function detail(relationships = RELATIONSHIPS): TicketDetail {
  return {
    id: "ticket-12",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Current ticket",
    description: "",
    workType: "feature",
    status: "in_progress",
    attachments: [],
    sessions: [],
    relationships,
    statusUpdates: { total: 0, recent: [] },
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T12:00:00.000Z",
  };
}

function renderRelationships(relationships = RELATIONSHIPS) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TicketRelationships
        projectName="command-center"
        number={12}
        relationships={relationships}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketRelationships", () => {
  it("groups relationships in contract order and renders cross-project links, status, and safe rationale Markdown", async () => {
    vi.stubGlobal("fetch", async () => Response.json(CANDIDATES));
    renderRelationships();

    const section = screen.getByRole("region", { name: "Relationships" });
    const headings = within(section).getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual([
      "Parent",
      "Children",
      "Depends on",
      "Blocks",
      "Related",
    ]);
    expect(
      within(section).getByRole("link", {
        name: /platform#8.*depends on ticket/,
      }),
    ).toHaveAttribute("href", "/tickets/platform/8");
    expect(
      within(section).getByRole("link", {
        name: /dashboard#4.*related ticket/,
      }),
    ).toHaveAttribute("href", "/tickets/dashboard/4");
    expect(await within(section).findByText("event ordering")).toHaveProperty(
      "tagName",
      "STRONG",
    );
    expect(within(section).getByText("Blocked")).toBeInTheDocument();
  });

  it("shows the section-level empty state while retaining add", () => {
    vi.stubGlobal("fetch", async () => Response.json(CANDIDATES));
    renderRelationships([]);
    const section = screen.getByRole("region", { name: "Relationships" });
    expect(
      within(section).getByText("No relationships yet."),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole("button", { name: "Add relationship" }),
    ).toBeInTheDocument();
    expect(within(section).queryByRole("heading", { level: 3 })).toBeNull();
  });

  it("disables only the removing row, preserves it on failure, and supports retry", async () => {
    let removeCount = 0;
    let resolveFirst: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if ((init?.method ?? "GET") === "GET") return Response.json(CANDIDATES);
        if (init?.method === "DELETE" && url.pathname.endsWith("/related-1")) {
          removeCount += 1;
          if (removeCount === 1) {
            return new Promise<Response>((resolve) => {
              resolveFirst = resolve;
            });
          }
          return Response.json({
            relationshipId: "related-1",
            tickets: [detail([])],
          });
        }
        return Response.json(detail());
      },
    );
    renderRelationships();
    const user = userEvent.setup();
    const row = screen.getByRole("listitem", { name: /dashboard#4/ });

    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() => expect(resolveFirst).not.toBeNull());
    expect(
      within(row).getByRole("button", { name: "Removing…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit parent-1" })).toBeEnabled();

    await act(async () => {
      resolveFirst!(
        Response.json(
          { error: "Relationship removal unavailable." },
          { status: 503 },
        ),
      );
    });
    const alert = await within(row).findByRole("alert");
    expect(alert).toHaveTextContent("Relationship removal unavailable");
    expect(row).toBeInTheDocument();
    await user.click(
      within(alert).getByRole("button", { name: "Retry remove" }),
    );
    await waitFor(() => expect(removeCount).toBe(2));
  });

  it("keeps edit failures in the rationale dialog and exposes pending state", async () => {
    let resolvePatch: ((response: Response) => void) | null = null;
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(CANDIDATES);
        if (init?.method === "PATCH") {
          return new Promise<Response>((resolve) => {
            resolvePatch = resolve;
          });
        }
        return Response.json(detail());
      },
    );
    renderRelationships();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Edit related-1" }));
    const rationale = await screen.findByRole("textbox", { name: "Rationale" });
    expect(rationale).toHaveValue("Shared **event ordering** rationale.");
    await user.clear(rationale);
    await user.type(rationale, "Updated rationale");
    await user.click(screen.getByRole("button", { name: "Save rationale" }));
    await waitFor(() => expect(resolvePatch).not.toBeNull());
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();

    await act(async () => {
      resolvePatch!(
        Response.json({ error: "Rationale update failed." }, { status: 503 }),
      );
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Rationale update failed",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(rationale).toHaveValue("Updated rationale");
  });

  it("requests an atomic reparent through the relative parent role", async () => {
    let requestBody: unknown;
    vi.stubGlobal(
      "fetch",
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "GET") return Response.json(CANDIDATES);
        if (init?.method === "POST") {
          requestBody = JSON.parse(String(init.body));
          return Response.json({
            relationship: relationship(
              "new-parent-link",
              "parent",
              "command-center",
              5,
            ),
            tickets: [detail()],
          });
        }
        return Response.json(detail());
      },
    );
    renderRelationships();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Add relationship" }));
    await user.click(await screen.findByRole("combobox", { name: "Role" }));
    await user.click(await screen.findByRole("option", { name: "Parent" }));
    const ticketInput = screen.getByRole("combobox", { name: "Ticket" });
    await user.click(ticketInput);
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Add relationship" }));

    await waitFor(() =>
      expect(requestBody).toEqual({
        target: { projectName: "command-center", number: 5 },
        role: "parent",
        description: "",
      }),
    );
  });
});
