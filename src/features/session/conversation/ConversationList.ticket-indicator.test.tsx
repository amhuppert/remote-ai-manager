// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { conversationKeys } from "@/lib/conversations/query-keys";
import { sessionKeys } from "@/lib/sessions/query-keys";
import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import { graphWorkflowExecutionKeys } from "@/lib/workflows/query-keys";
import ConversationList from "./ConversationList";

function seedSessionPage(
  queryClient: QueryClient,
  projectName: string,
  sessionName: string,
): void {
  queryClient.setQueryData(sessionKeys.detail(projectName, sessionName), {
    sessionName,
    worktreePath: `/repos/${projectName}/.worktrees/${sessionName}`,
    branchName: `csm/${sessionName}`,
    targetBranch: "main",
    parentSessionName: null,
    createdAt: "2026-07-01T09:00:00.000Z",
    lastActivityAt: "2026-07-01T10:00:00.000Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    graphWorkflowExecution: null,
    referenceDocuments: [],
  });
  queryClient.setQueryData(conversationKeys.list(projectName, sessionName), []);
  queryClient.setQueryData(
    graphWorkflowExecutionKeys.detail(projectName, sessionName),
    null,
  );
}

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app/implement-auth",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("ConversationList ticket indicator", () => {
  it.each([
    [true, null],
    [false, "2026-07-02T10:00:00.000Z"],
  ])(
    "shows the linked ticket on the direct session page (active=%s)",
    async (active, endedAt) => {
      const sessionName = "implement-auth";
      const link: TicketLinkSummary = {
        ticketId: "ticket-12",
        projectName: "my-app",
        number: 12,
        title: "Harden the auth flow",
        active,
        linkedAt: "2026-07-01T10:00:00.000Z",
        endedAt,
      };
      const queryClient = new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Infinity,
            refetchInterval: false,
          },
        },
      });
      seedSessionPage(queryClient, "my-app", sessionName);
      queryClient.setQueryData(sessionKeys.detail("my-app", sessionName), {
        ...queryClient.getQueryData<object>(
          sessionKeys.detail("my-app", sessionName),
        ),
        finished: !active,
      });
      queryClient.setQueryData(ticketKeys.sessionLinks("my-app"), {
        [sessionName]: link,
      });
      vi.stubGlobal("fetch", async () =>
        Response.json({ error: "not used" }, { status: 404 }),
      );

      render(
        <QueryClientProvider client={queryClient}>
          <ConversationList projectName="my-app" sessionName={sessionName} />
        </QueryClientProvider>,
      );

      const indicator = await screen.findByRole("link", { name: "my-app#12" });
      expect(indicator).toHaveAttribute("href", "/tickets/my-app/12");
      if (active) expect(indicator).toHaveAttribute("data-active");
      else expect(indicator).not.toHaveAttribute("data-active");
    },
  );

  it("treats its project prop as already decoded", async () => {
    const projectName = "literal%20project";
    const sessionName = "ticket-session";
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchInterval: false },
      },
    });
    seedSessionPage(queryClient, projectName, sessionName);
    queryClient.setQueryData(ticketKeys.sessionLinks(projectName), {});
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: "not used" }, { status: 404 }),
    );

    render(
      <QueryClientProvider client={queryClient}>
        <ConversationList projectName={projectName} sessionName={sessionName} />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(projectName)).toBeInTheDocument();
  });
});
