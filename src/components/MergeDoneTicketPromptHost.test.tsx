// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MergeDoneTicketPrompt } from "@/lib/tickets/merge-done-prompt";
import { useNotificationStore } from "@/stores/notification.store";
import { useToastStoreForTesting as useToastStore } from "@/stores/toast.store";

import MergeDoneTicketPromptHost from "./MergeDoneTicketPromptHost";

/** The SSE reaction enqueues from outside React; act() flushes the subscription. */
function enqueue(item: MergeDoneTicketPrompt) {
  act(() => {
    useNotificationStore.getState().enqueueMergeDonePrompt(item);
  });
}

const prompt: MergeDoneTicketPrompt = {
  jobId: "job-1",
  projectName: "command-center",
  sessionName: "csm/ticket-37",
  ticketNumber: 37,
  ticketTitle: "Suggest moving ticket to Done on merge",
};

function ticketDetailBody(status: string) {
  return {
    id: "ticket-1",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 37,
    title: "Suggest moving ticket to Done on merge",
    description: "",
    workType: "feature",
    status,
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-31T00:00:00.000Z",
    attachments: [],
    sessions: [],
  };
}

function renderHost() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <MergeDoneTicketPromptHost />
    </QueryClientProvider>,
  );
}

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  useNotificationStore.setState({ mergeDonePromptQueue: [] });
  useToastStore.setState({ toasts: [] });
  fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify(ticketDetailBody("done")), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
  useNotificationStore.setState({ mergeDonePromptQueue: [] });
});

describe("MergeDoneTicketPromptHost", () => {
  it("renders nothing while no merge has suggested a ticket", () => {
    const { container } = renderHost();
    expect(container.innerHTML).toBe("");
  });

  it("names the linked ticket in the suggestion raised by a completed merge", () => {
    renderHost();
    enqueue(prompt);

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("command-center#37");
    expect(dialog).toHaveTextContent("Suggest moving ticket to Done on merge");
  });

  it("moves the ticket to Done when the user accepts", async () => {
    const user = userEvent.setup();
    renderHost();
    enqueue(prompt);

    await user.click(screen.getByRole("button", { name: /move to done/i }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/projects/command-center/tickets/37");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ status: "done" });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("leaves the ticket untouched when the user declines", async () => {
    const user = userEvent.setup();
    renderHost();
    enqueue(prompt);

    await user.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(useNotificationStore.getState().mergeDonePromptQueue).toEqual([]);
  });

  it("says so when the Done move fails, since the dialog is already gone", async () => {
    const user = userEvent.setup();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }),
    );
    renderHost();
    enqueue(prompt);

    await user.click(screen.getByRole("button", { name: /move to done/i }));

    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toMatch(
        /command-center#37/,
      ),
    );
    expect(useToastStore.getState().toasts[0]?.message).toMatch(/couldn't/i);
  });

  it("asks again for the next merged session once the first is answered", async () => {
    const user = userEvent.setup();
    renderHost();
    enqueue(prompt);
    enqueue({
      ...prompt,
      jobId: "job-2",
      sessionName: "csm/ticket-40",
      ticketNumber: 40,
      ticketTitle: "Another ticket",
    });

    await user.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() =>
      expect(screen.getByRole("alertdialog")).toHaveTextContent(
        "command-center#40",
      ),
    );
  });
});
