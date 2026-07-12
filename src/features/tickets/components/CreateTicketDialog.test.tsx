// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketDetail } from "@/lib/tickets/schemas";
import CreateTicketDialog from "./CreateTicketDialog";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const CREATED_TICKET: TicketDetail = {
  id: "ticket-13",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 13,
  title: "Old pending create",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [],
  sessions: [],
};

interface DeferredCreate {
  queryClient: QueryClient;
  resolve(response: Response): void;
}

function renderDeferredCreate(): DeferredCreate {
  let resolve: (response: Response) => void = () => {
    throw new Error("Create request has not started");
  };
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      );
      const method = init?.method?.toUpperCase() ?? "GET";
      if (method === "GET" && url.pathname === "/api/projects") {
        return Response.json([
          {
            name: "command-center",
            path: "/repos/command-center",
            activeSessions: 0,
            hasRunningSession: false,
          },
        ]);
      }
      if (
        method === "POST" &&
        url.pathname === "/api/projects/command-center/tickets"
      ) {
        return await new Promise<Response>((requestResolve) => {
          resolve = requestResolve;
        });
      }
      return Response.json({ error: "not mocked" }, { status: 404 });
    },
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  function Harness(): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <QueryClientProvider client={queryClient}>
        <button type="button" onClick={() => setOpen(true)}>
          New ticket
        </button>
        <CreateTicketDialog
          open={open}
          onOpenChange={setOpen}
          initialProjectName="command-center"
        />
      </QueryClientProvider>
    );
  }

  render(<Harness />);
  return { queryClient, resolve: (response) => resolve(response) };
}

async function submitCloseAndReopen(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "New ticket" }));
  await user.type(await screen.findByLabelText("Title"), "Old pending create");
  await user.click(screen.getByRole("button", { name: "Create ticket" }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toBeDisabled());

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  const opener = screen.getByRole("button", { name: "New ticket" });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  expect(await screen.findByRole("dialog")).toHaveTextContent("New ticket");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CreateTicketDialog request ownership", () => {
  it("moves focus to the primary action when creation replaces the form", async () => {
    const deferred = renderDeferredCreate();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "New ticket" }));
    await user.type(
      await screen.findByLabelText("Title"),
      CREATED_TICKET.title,
    );
    await user.click(screen.getByRole("button", { name: "Create ticket" }));

    await act(async () => {
      deferred.resolve(Response.json(CREATED_TICKET, { status: 201 }));
      await Promise.resolve();
    });

    const addContext = await screen.findByRole("button", {
      name: "Add context",
    });
    await waitFor(() => expect(document.activeElement).toBe(addContext));
  });

  it("keeps a reopened form fresh when an older create succeeds", async () => {
    const deferred = renderDeferredCreate();
    await submitCloseAndReopen();

    await act(async () => {
      deferred.resolve(Response.json(CREATED_TICKET, { status: 201 }));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText("Title")).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent("New ticket");
    expect(screen.queryByText("Ticket created")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
    expect(
      deferred.queryClient.getQueryData(
        ticketKeys.detail("command-center", 13),
      ),
    ).toEqual(CREATED_TICKET);
  });

  it("does not inject an older create error into a reopened form", async () => {
    const deferred = renderDeferredCreate();
    await submitCloseAndReopen();

    await act(async () => {
      deferred.resolve(
        Response.json(
          { error: "Old create failed after the dialog closed." },
          { status: 500 },
        ),
      );
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByLabelText("Title")).toBeEnabled());
    expect(screen.getByRole("dialog")).toHaveTextContent("New ticket");
    expect(
      screen.queryByText("Old create failed after the dialog closed."),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Title")).toHaveValue("");
  });
});
