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

import { ticketKeys } from "@/lib/tickets/query-keys";
import type {
  TicketDetail,
  TicketStatusUpdate,
  TicketStatusUpdatePage,
} from "@/lib/tickets/schemas";
import TicketStatusUpdates from "./TicketStatusUpdates";

const USER_UPDATE: TicketStatusUpdate = {
  id: "update-user",
  ticketId: "ticket-12",
  bodyMarkdown: "Shipped the **cache fix**.",
  author: { kind: "user" },
  createdAt: "2026-08-30T14:00:00.000Z",
};

const AGENT_UPDATE: TicketStatusUpdate = {
  id: "update-agent",
  ticketId: "ticket-12",
  bodyMarkdown: "Reviewed [the plan](https://example.com/plan).",
  author: {
    kind: "agent",
    scope: "session",
    conversationId: "conversation-42",
    conversationName: "Cache review",
    projectName: "command-center",
    sessionName: "ticket-12-cache",
    backend: "codex",
    redactedProfileSnapshot: {
      tier: "project",
      id: "cache-reviewer",
      name: "Cache reviewer",
      revision: 2,
      sourceContentHash: `sha256:${"1".repeat(64)}`,
      resolvedInstructionHash: `sha256:${"2".repeat(64)}`,
    },
  },
  createdAt: "2026-08-30T13:00:00.000Z",
};

function detailWith(updates: TicketStatusUpdate[]): TicketDetail {
  return {
    id: "ticket-12",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Converge ticket caches",
    description: "",
    workType: "feature",
    status: "in_progress",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T14:00:00.000Z",
    attachments: [],
    sessions: [],
    relationships: [],
    statusUpdates: { total: updates.length, recent: updates.slice(0, 5) },
  };
}

function page(
  items: TicketStatusUpdate[],
  nextCursor: string | null = null,
): TicketStatusUpdatePage {
  return { items, total: items.length, nextCursor };
}

function renderUpdates(
  options: {
    pages?: TicketStatusUpdatePage[];
    pageParams?: Array<string | null>;
    fetch?: typeof globalThis.fetch;
  } = {},
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  if (options.pages !== undefined) {
    queryClient.setQueryData(ticketKeys.statusUpdates("command-center", 12), {
      pages: options.pages,
      pageParams: options.pageParams ?? [null],
    });
  }
  if (options.fetch !== undefined) vi.stubGlobal("fetch", options.fetch);
  render(
    <QueryClientProvider client={queryClient}>
      <TicketStatusUpdates projectName="command-center" number={12} />
    </QueryClientProvider>,
  );
  return queryClient;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketStatusUpdates", () => {
  it("renders safe Markdown with user and linked agent attribution", async () => {
    renderUpdates({ pages: [page([USER_UPDATE, AGENT_UPDATE])] });

    const section = screen.getByRole("region", { name: "Status updates" });
    expect((await within(section).findByText("cache fix")).tagName).toBe(
      "STRONG",
    );
    expect(within(section).getByText("User")).toBeInTheDocument();
    expect(
      within(section).getByRole("link", { name: "Cache reviewer" }),
    ).toHaveAttribute("href", "/conversations?c=conversation-42");
    expect(within(section).getByText("Codex")).toBeInTheDocument();
    expect(
      await within(section).findByRole("link", { name: "the plan" }),
    ).toHaveAttribute("href", "https://example.com/plan");
  });

  it("keeps the composer visible, validates whitespace, and submits with the keyboard", async () => {
    const requests: Array<{ method: string; body: unknown }> = [];
    let resolvePost: ((response: Response) => void) | null = null;
    renderUpdates({
      pages: [page([])],
      fetch: async (_input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          body:
            init?.body === undefined
              ? undefined
              : JSON.parse(String(init.body)),
        });
        if (init?.method === "POST") {
          return new Promise<Response>((resolve) => {
            resolvePost = resolve;
          });
        }
        return Response.json(page([]));
      },
    });
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "Status update" });

    await user.type(composer, "   ");
    await user.click(screen.getByRole("button", { name: "Post update" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an update");
    expect(
      requests.filter((request) => request.method === "POST"),
    ).toHaveLength(0);

    await user.clear(composer);
    await user.type(composer, "Ready for review");
    await user.keyboard("{Control>}{Enter}{/Control}");

    await waitFor(() => expect(resolvePost).not.toBeNull());
    expect(requests.find((request) => request.method === "POST")).toEqual({
      method: "POST",
      body: { bodyMarkdown: "Ready for review" },
    });
    expect(screen.getByRole("button", { name: "Posting…" })).toBeDisabled();
    expect(composer).toBeDisabled();

    await act(async () => {
      resolvePost!(
        Response.json({
          update: USER_UPDATE,
          ticket: detailWith([USER_UPDATE]),
        }),
      );
    });
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("preserves a failed post for a successful retry", async () => {
    let postCount = 0;
    renderUpdates({
      pages: [page([])],
      fetch: async (_input, init) => {
        if (init?.method === "POST") {
          postCount += 1;
          if (postCount === 1) {
            return Response.json(
              { error: "Posting is temporarily unavailable." },
              { status: 503 },
            );
          }
          return Response.json({
            update: USER_UPDATE,
            ticket: detailWith([USER_UPDATE]),
          });
        }
        return Response.json(page([USER_UPDATE]));
      },
    });
    const user = userEvent.setup();
    const composer = screen.getByRole("textbox", { name: "Status update" });
    await user.type(composer, USER_UPDATE.bodyMarkdown);
    await user.click(screen.getByRole("button", { name: "Post update" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Posting is temporarily unavailable");
    expect(composer).toHaveValue(USER_UPDATE.bodyMarkdown);
    await user.click(within(alert).getByRole("button", { name: "Retry post" }));

    expect(await screen.findByText("cache fix")).toBeInTheDocument();
    expect(composer).toHaveValue("");
    expect(postCount).toBe(2);
  });

  it("loads older pages newest-first and keeps page failures local", async () => {
    let pageFails = true;
    renderUpdates({
      pages: [{ ...page([USER_UPDATE], "older-cursor"), total: 2 }],
      fetch: async (input) => {
        const url = new URL(String(input), "http://localhost");
        expect(url.searchParams.get("cursor")).toBe("older-cursor");
        if (pageFails) {
          return Response.json(
            { error: "Older updates unavailable." },
            { status: 503 },
          );
        }
        return Response.json({
          items: [AGENT_UPDATE],
          total: 2,
          nextCursor: null,
        });
      },
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Load older" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Older updates unavailable");
    expect(screen.getByText("cache fix")).toBeInTheDocument();

    pageFails = false;
    await user.click(
      within(alert).getByRole("button", { name: "Retry older updates" }),
    );
    expect(await screen.findByText(/Reviewed/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });

  it("shows local initial loading, failure, and empty states", async () => {
    let resolveInitial: ((response: Response) => void) | null = null;
    const view = renderUpdates({
      fetch: () =>
        new Promise<Response>((resolve) => {
          resolveInitial = resolve;
        }),
    });
    expect(screen.getByText("Loading updates…")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "Status update" }),
    ).toBeInTheDocument();

    await waitFor(() => expect(resolveInitial).not.toBeNull());
    await act(async () => {
      resolveInitial!(
        Response.json({ error: "Updates unavailable." }, { status: 503 }),
      );
      await Promise.resolve();
    });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Updates unavailable");

    view.setQueryData(ticketKeys.statusUpdates("command-center", 12), {
      pages: [page([])],
      pageParams: [null],
    });
    await waitFor(() =>
      expect(screen.getByText("No status updates yet.")).toBeInTheDocument(),
    );
  });
});
