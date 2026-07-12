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
import { useTicketDetailQuery } from "@/lib/tickets/queries";
import type { TicketDetail } from "@/lib/tickets/schemas";
import { useToastStoreForTesting } from "@/stores/toast.store";
import AttachmentIndex from "./AttachmentIndex";

const DETAIL: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Attachment callback lifetime",
  description: "",
  workType: "bug",
  status: "in_progress",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [
    {
      id: "attachment-1",
      ticketId: "ticket-12",
      description: "Failure report",
      payload: { kind: "note", markdown: "## Failure" },
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    },
  ],
  sessions: [],
};

function CacheBackedIndex(): React.JSX.Element | null {
  const detail = useTicketDetailQuery("command-center", 12).data;
  if (!detail) return null;
  return (
    <AttachmentIndex
      projectName={detail.projectName}
      number={detail.number}
      attachments={detail.attachments}
    />
  );
}

function renderIndex() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  queryClient.setQueryData(ticketKeys.detail("command-center", 12), DETAIL);
  return render(
    <QueryClientProvider client={queryClient}>
      <CacheBackedIndex />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useToastStoreForTesting.setState({ toasts: [] });
});

describe("AttachmentIndex mutation feedback", () => {
  it("reports a removal failure after the optimistic removal unmounts its entry", async () => {
    let resolveDelete: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "DELETE") {
        throw new Error("Unexpected attachment request");
      }
      return new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    });
    renderIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    await user.click(within(entry).getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Remove",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("listitem", { name: "Failure report" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(resolveDelete).not.toBeNull());

    await act(async () => {
      resolveDelete!(
        Response.json({ error: "remove failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't remove")),
      ).toBe(true),
    );
  });

  it("reports an edit failure after Save closes and unmounts the edit form", async () => {
    let resolvePatch: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== "PATCH") {
        throw new Error("Unexpected attachment request");
      }
      return new Promise<Response>((resolve) => {
        resolvePatch = resolve;
      });
    });
    renderIndex();
    const user = userEvent.setup();

    const entry = await screen.findByRole("listitem", {
      name: "Failure report",
    });
    await user.click(within(entry).getByRole("button", { name: "Edit" }));
    await user.clear(await within(entry).findByLabelText("Description"));
    await user.type(within(entry).getByLabelText("Description"), "Retitled");
    await user.click(within(entry).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(resolvePatch).not.toBeNull());
    expect(
      within(entry).queryByLabelText("Description"),
    ).not.toBeInTheDocument();

    await act(async () => {
      resolvePatch!(Response.json({ error: "edit failed" }, { status: 500 }));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't save")),
      ).toBe(true),
    );
  });
});
