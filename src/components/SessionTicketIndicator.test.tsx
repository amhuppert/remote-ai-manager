// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ticketKeys } from "@/lib/tickets/query-keys";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import SessionTicketIndicator from "./SessionTicketIndicator";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/projects/my-app",
  useSearchParams: () => new URLSearchParams(),
}));

const LINKS: Record<string, TicketLinkSummary> = {
  "implement-auth": {
    ticketId: "t-1",
    projectName: "my-app",
    number: 12,
    title: "Harden the auth flow",
    active: true,
    linkedAt: "2026-07-01T10:00:00.000Z",
    endedAt: null,
  },
  "refactor-api": {
    ticketId: "t-2",
    projectName: "my-app",
    number: 7,
    title: "Collapse the v1 API shims",
    active: false,
    linkedAt: "2026-06-20T10:00:00.000Z",
    endedAt: "2026-06-22T10:00:00.000Z",
  },
};

function mockSessionLinksFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/projects/my-app/tickets/session-links") {
      return Response.json(LINKS);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function renderIndicator(sessionName: string) {
  const restore = mockSessionLinksFetch();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <SessionTicketIndicator projectName="my-app" sessionName={sessionName} />
    </QueryClientProvider>,
  );
  return { view, restore, queryClient };
}

afterEach(cleanup);

describe("SessionTicketIndicator", () => {
  it("renders an active link as a navigable identifier pill with the active treatment", async () => {
    const { restore } = renderIndicator("implement-auth");
    try {
      const link = await screen.findByRole("link", { name: "my-app#12" });
      expect(link).toHaveAttribute("href", "/tickets/my-app/12");
      expect(link).toHaveAttribute("title", "Harden the auth flow");
      expect(link).toHaveAttribute("data-active");
    } finally {
      restore();
    }
  });

  it("renders a historical link with the muted treatment", async () => {
    const { restore } = renderIndicator("refactor-api");
    try {
      const link = await screen.findByRole("link", { name: "my-app#7" });
      expect(link).toHaveAttribute("href", "/tickets/my-app/7");
      expect(link).not.toHaveAttribute("data-active");
    } finally {
      restore();
    }
  });

  it("renders nothing for a session with no ticket link", async () => {
    const { restore, queryClient } = renderIndicator("add-dashboard");
    try {
      // Let the session-links query settle, then confirm no indicator appeared.
      await waitFor(() => expect(queryClient.isFetching()).toBe(0));
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    } finally {
      restore();
    }
  });

  it("degrades stale active link data when its liveness refresh fails", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () =>
      Response.json({ error: "unavailable" }, { status: 503 });
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchInterval: false },
      },
    });
    const linksKey = ticketKeys.sessionLinks("my-app");
    queryClient.setQueryData(linksKey, LINKS);

    try {
      render(
        <QueryClientProvider client={queryClient}>
          <SessionTicketIndicator
            projectName="my-app"
            sessionName="implement-auth"
          />
        </QueryClientProvider>,
      );
      const link = screen.getByRole("link", { name: "my-app#12" });
      expect(link).toHaveAttribute("data-active");

      await queryClient.invalidateQueries({
        queryKey: linksKey,
      });
      await waitFor(() =>
        expect(queryClient.getQueryState(linksKey)?.status).toBe("error"),
      );

      expect(link).not.toHaveAttribute("data-active");
      expect(link).toHaveAttribute("data-liveness", "unknown");
      expect(link).toHaveAccessibleName(
        "my-app#12, ticket link status unavailable",
      );
      expect(link).toHaveTextContent("my-app#12?");
    } finally {
      globalThis.fetch = original;
    }
  });
});
