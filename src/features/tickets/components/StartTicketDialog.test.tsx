// @vitest-environment jsdom
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketDetail } from "@/lib/tickets/schemas";
import StartTicketDialog from "./StartTicketDialog";

const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

function renderDialog(onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <StartTicketDialog
        projectName="command-center"
        number={12}
        open
        onOpenChange={onOpenChange}
      />
    </QueryClientProvider>,
  );
  return onOpenChange;
}

const STARTED_TICKET: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Harden ticket context",
  description: "",
  workType: "feature",
  status: "in_progress",
  createdAt: "2026-07-10T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [],
  sessions: [],
};

function renderDeferredStart() {
  let resolve: (response: Response) => void = () => {
    throw new Error("Start request has not started");
  };
  vi.stubGlobal(
    "fetch",
    async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "POST") {
        return Response.json({ error: "not mocked" }, { status: 404 });
      }
      return await new Promise<Response>((requestResolve) => {
        resolve = requestResolve;
      });
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
          Open start dialog
        </button>
        <StartTicketDialog
          projectName="command-center"
          number={12}
          open={open}
          onOpenChange={setOpen}
        />
      </QueryClientProvider>
    );
  }

  render(<Harness />);
  return { queryClient, resolve: (response: Response) => resolve(response) };
}

async function submitCloseAndReopenStart(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Open start dialog" }));
  await user.click(await screen.findByRole("button", { name: "Start work" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Provisioning…" }),
    ).toBeDisabled(),
  );

  await user.click(screen.getByRole("button", { name: "Cancel" }));
  const opener = screen.getByRole("button", { name: "Open start dialog" });
  await waitFor(() => expect(document.activeElement).toBe(opener));
  await user.click(opener);
  expect(await screen.findByRole("dialog")).toHaveTextContent("Start work");
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  routerPush.mockClear();
});

describe("StartTicketDialog", () => {
  it("uses the visible mode text as the radio group's accessible label", () => {
    renderDialog();

    expect(screen.getByText("Mode").tagName).toBe("SPAN");
    expect(
      screen.getByRole("radiogroup", { name: "Mode" }),
    ).toBeInTheDocument();
  });

  it("keeps an agent-start warning visible and links to the prepared session when kickoff was not queued", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        ticket: {
          id: "ticket-12",
          projectPath: "/repos/command-center",
          projectName: "command-center",
          number: 12,
          title: "Harden ticket context",
          description: "",
          workType: "feature",
          status: "in_progress",
          createdAt: "2026-07-10T10:00:00.000Z",
          updatedAt: "2026-07-11T10:00:00.000Z",
          attachments: [],
          sessions: [],
        },
        sessionName: "csm/harden-ticket-context",
        conversationId: "conv-12",
        initialPromptQueued: false,
      }),
    );
    const onOpenChange = renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Start work" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /kickoff could not be queued/i,
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    const openPrepared = screen.getByRole("button", {
      name: "Open prepared session",
    });
    await waitFor(() => expect(document.activeElement).toBe(openPrepared));

    await user.click(openPrepared);
    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith(
        "/projects/command-center/csm%2Fharden-ticket-context",
      ),
    );
  });

  it("announces a start failure without closing the dialog", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json(
        { error: "Provisioning failed before session creation." },
        { status: 500 },
      ),
    );
    const onOpenChange = renderDialog();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Start work" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Provisioning failed before session creation",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("does not close a reopened dialog when an older start succeeds", async () => {
    const deferred = renderDeferredStart();
    await submitCloseAndReopenStart();

    await act(async () => {
      deferred.resolve(
        Response.json({
          ticket: STARTED_TICKET,
          sessionName: "csm/harden-ticket-context",
          conversationId: "conv-12",
          initialPromptQueued: true,
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled(),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Start work");
    expect(
      deferred.queryClient.getQueryData(
        ticketKeys.detail("command-center", 12),
      ),
    ).toEqual(STARTED_TICKET);
  });

  it("does not inject an older start error into a reopened dialog", async () => {
    const deferred = renderDeferredStart();
    await submitCloseAndReopenStart();

    await act(async () => {
      deferred.resolve(
        Response.json(
          { error: "Old start failed after the dialog closed." },
          { status: 500 },
        ),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Start work" })).toBeEnabled(),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("Start work");
    expect(
      screen.queryByText("Old start failed after the dialog closed."),
    ).not.toBeInTheDocument();
  });
});
