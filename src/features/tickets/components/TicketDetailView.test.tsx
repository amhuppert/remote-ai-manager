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

import type { TicketDetail } from "@/lib/tickets/schemas";
import { ticketKeys } from "@/lib/tickets/query-keys";
import { useToastStoreForTesting } from "@/stores/toast.store";
import TicketDetailView from "./TicketDetailView";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets/command-center/12",
  useSearchParams: () => new URLSearchParams(),
}));

const DETAIL: TicketDetail = {
  id: "ticket-12",
  projectPath: "/repos/command-center",
  projectName: "command-center",
  number: 12,
  title: "Recover the ticket view",
  description: "",
  workType: "feature",
  status: "not_started",
  createdAt: "2026-07-11T10:00:00.000Z",
  updatedAt: "2026-07-11T10:00:00.000Z",
  attachments: [],
  sessions: [],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useToastStoreForTesting.setState({ toasts: [] });
});

function renderDetail(
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  }),
) {
  return render(
    <QueryClientProvider client={queryClient}>
      <TicketDetailView projectName="command-center" number={12} />
    </QueryClientProvider>,
  );
}

describe("TicketDetailView loading failures", () => {
  it("offers a retry for a non-not-found failure", async () => {
    let detailRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path === "/api/projects/command-center/tickets/12") {
        detailRequests += 1;
        if (detailRequests === 1) {
          return Response.json(
            { error: "Ticket service unavailable." },
            { status: 503 },
          );
        }
        return Response.json(DETAIL);
      }
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      if (path === "/api/notifications") {
        return Response.json({ notifications: [], total: 0, unreadCount: 0 });
      }
      if (path === "/api/conversations/active") {
        return Response.json({
          conversations: [],
          graphWorkflowExecutions: [],
          activeCollaborationExecutions: [],
        });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <TicketDetailView projectName="command-center" number={12} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();

    const failure = await screen.findByRole("alert");
    await user.click(
      within(failure).getByRole("button", { name: "Retry ticket" }),
    );

    expect(
      await screen.findByRole("heading", { name: "Recover the ticket view" }),
    ).toBeInTheDocument();
  });

  it("does not label an unverified live session as ended when liveness fails", async () => {
    const detailWithSession: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-recover-1",
          sessionCreatedAt: "2026-07-11T10:00:01.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) {
        return Response.json(
          { error: "Session liveness unavailable." },
          { status: 503 },
        );
      }
      return Response.json(detailWithSession);
    });

    renderDetail();

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    expect(
      await within(sessions).findByText("Session status unavailable"),
    ).toBeInTheDocument();
    expect(
      within(sessions).getByRole("button", { name: "Retry sessions" }),
    ).toBeInTheDocument();
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("ended")).not.toBeInTheDocument();
  });

  it("stops trusting cached active liveness after a refresh fails", async () => {
    const detailWithSession: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-recover-1",
          sessionCreatedAt: "2026-07-11T10:00:01.000Z",
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    let linksRequests = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) {
        linksRequests += 1;
        if (linksRequests > 1) {
          return Response.json(
            { error: "Session liveness unavailable." },
            { status: 503 },
          );
        }
        return Response.json({
          "ticket-12-recover-1": {
            ticketId: DETAIL.id,
            projectName: DETAIL.projectName,
            number: DETAIL.number,
            title: DETAIL.title,
            linkedAt: "2026-07-11T10:00:01.000Z",
            endedAt: null,
            active: true,
          },
        });
      }
      return Response.json(detailWithSession);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDetail(queryClient);

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    expect(await within(sessions).findByText("active")).toBeInTheDocument();

    await act(async () => {
      await queryClient.invalidateQueries({
        queryKey: ticketKeys.sessionLinks(DETAIL.projectName),
      });
    });

    expect(
      await within(sessions).findByText("Session status unavailable"),
    ).toBeInTheDocument();
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("active")).not.toBeInTheDocument();
  });

  it("does not infer ended from a conservative negative liveness result", async () => {
    const detailWithLegacyOpenLink: TicketDetail = {
      ...DETAIL,
      sessions: [
        {
          id: "legacy-link-1",
          ticketId: DETAIL.id,
          projectPath: DETAIL.projectPath,
          sessionName: "ticket-12-legacy-1",
          sessionCreatedAt: null,
          startMode: "prepared",
          linkedAt: "2026-07-11T10:00:01.000Z",
          endedAt: null,
          endReason: null,
        },
      ],
    };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (path.endsWith("/tickets/session-links")) return Response.json({});
      return Response.json(detailWithLegacyOpenLink);
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderDetail(queryClient);

    const sessions = await screen.findByRole("region", { name: "Sessions" });
    await waitFor(() =>
      expect(
        queryClient.getQueryState(ticketKeys.sessionLinks(DETAIL.projectName))
          ?.status,
      ).toBe("success"),
    );
    expect(within(sessions).getByText("status unknown")).toBeInTheDocument();
    expect(within(sessions).queryByText("ended")).not.toBeInTheDocument();
  });
});

describe("TicketDetailView mutation feedback", () => {
  it("reports a delete failure after optimistic navigation unmounts the dossier", async () => {
    let resolveDelete: ((response: Response) => void) | null = null;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          resolveDelete = resolve;
        });
      }
      if (path.endsWith("/tickets/session-links")) {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json(DETAIL));
    });
    const view = renderDetail();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: DETAIL.title });
    await user.click(screen.getByRole("button", { name: "Delete ticket" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );
    await waitFor(() => expect(resolveDelete).not.toBeNull());
    view.unmount();
    await act(async () => {
      resolveDelete!(
        Response.json({ error: "delete failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Couldn't delete")),
      ).toBe(true),
    );
  });

  it("reports the first failure when rapid field changes overlap", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(
        typeof input === "string" ? input : input.toString(),
        "http://localhost",
      ).pathname;
      if (init?.method === "PATCH") {
        return new Promise<Response>((resolve) => patchResolvers.push(resolve));
      }
      if (path.endsWith("/tickets/session-links")) {
        return Promise.resolve(Response.json({}));
      }
      return Promise.resolve(Response.json(DETAIL));
    });
    renderDetail();
    const user = userEvent.setup();

    await screen.findByRole("heading", { name: DETAIL.title });
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Blocked" }));
    await user.click(screen.getByRole("combobox", { name: "Work type" }));
    await user.click(await screen.findByRole("option", { name: "Bug" }));

    await waitFor(() => expect(patchResolvers).toHaveLength(1));
    await act(async () => {
      patchResolvers[0]!(
        Response.json({ error: "status failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => expect(patchResolvers).toHaveLength(2));
    await act(async () => {
      patchResolvers[1]!(
        Response.json({
          ...DETAIL,
          workType: "bug",
          updatedAt: "2026-07-11T10:00:01.000Z",
        }),
      );
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(
        useToastStoreForTesting
          .getState()
          .toasts.some((toast) => toast.message.includes("Blocked")),
      ).toBe(true),
    );
  });
});
