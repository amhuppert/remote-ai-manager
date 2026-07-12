// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TicketDetail } from "@/lib/tickets/schemas";
import { TicketTitleEditor } from "./TicketEditor";

const DETAIL: TicketDetail = {
  id: "ticket-1",
  projectPath: "/repos/alpha",
  projectName: "alpha",
  number: 1,
  title: "Original",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z",
  attachments: [],
  sessions: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TicketTitleEditor mutation feedback", () => {
  it("retains the first failure when a second save is queued", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") throw new Error("Unexpected request");
      return new Promise<Response>((resolve) => patchResolvers.push(resolve));
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      <QueryClientProvider client={client}>
        <TicketTitleEditor projectName="alpha" number={1} title="Original" />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    const saveTitle = async (title: string) => {
      await user.click(screen.getByRole("heading", { name: "Original" }));
      const input = screen.getByRole("textbox", { name: "Ticket title" });
      await user.clear(input);
      await user.type(input, title);
      await user.click(screen.getByRole("button", { name: "Save" }));
      await screen.findByRole("heading", { name: "Original" });
    };
    await saveTitle("First save");
    await saveTitle("Second save");
    await waitFor(() => expect(patchResolvers).toHaveLength(1));

    await act(async () => {
      patchResolvers[0]!(
        Response.json({ error: "first failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(patchResolvers).toHaveLength(2));

    expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");

    await act(async () => {
      patchResolvers[1]!(
        Response.json({
          ...DETAIL,
          title: "Second save",
          updatedAt: "2026-07-01T00:00:01.000Z",
        }),
      );
      await Promise.resolve();
    });
  });
});
