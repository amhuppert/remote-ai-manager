// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import SessionInfoStrip from "./SessionInfoStrip";

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

const TICKET_LINKS: Record<string, TicketLinkSummary> = {
  "implement-auth": {
    ticketId: "t-1",
    projectName: "my-app",
    number: 12,
    title: "Harden the auth flow",
    active: true,
    linkedAt: "2026-07-01T10:00:00.000Z",
    endedAt: null,
  },
};

function mockStripFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, "http://localhost");
    if (parsed.pathname === "/api/projects/my-app/tickets/session-links") {
      return Response.json(TICKET_LINKS);
    }
    // The strip's other chips (alignment, compaction) tolerate missing data;
    // their queries settle into empty/error states.
    return Response.json({ error: "not mocked" }, { status: 404 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

const SESSION = sessionStateSchema.parse({
  sessionName: "implement-auth",
  worktreePath: "/tmp/wt/implement-auth",
  branchName: "csm/implement-auth",
  createdAt: "2026-06-30T10:00:00.000Z",
  lastActivityAt: "2026-07-01T12:00:00.000Z",
});

function renderStrip() {
  const restore = mockStripFetch();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <SessionInfoStrip
        session={SESSION}
        activeConversation={undefined}
        projectName="my-app"
        sessionName="implement-auth"
        conversationId="conv-1"
        statusDotClass="status-dot-cyan"
        displayStatus="working"
        contextPercent={null}
        buildContext={() => null}
        tddEnabled={false}
        onTddChange={() => {}}
        tddDisabled={false}
        layout="split"
        onLayoutChange={() => {}}
        dsOpen={false}
        dsServers={[]}
        dsClose={() => {}}
        dsToggle={() => {}}
        dsStartServer={() => {}}
        dsStopServer={() => {}}
        dsStartAll={() => {}}
        dsStopAll={() => {}}
        targetBranch="main"
        onDelete={() => {}}
      />
    </QueryClientProvider>,
  );
  return restore;
}

afterEach(cleanup);

describe("SessionInfoStrip ticket indicator", () => {
  it("shows the linked ticket's identifier chip navigating to the detail view", async () => {
    const restore = renderStrip();
    try {
      const chip = await screen.findByRole("link", { name: "my-app#12" });
      expect(chip).toHaveAttribute("href", "/tickets/my-app/12");
      expect(chip).toHaveAttribute("data-active");
    } finally {
      restore();
    }
  });

  it("does not hide the linked ticket indicator with the desktop-only strip on mobile", async () => {
    const restore = renderStrip();
    try {
      const chip = await screen.findByRole("link", { name: "my-app#12" });
      const indicatorRegion = chip.closest("[data-session-ticket-region]");
      expect(indicatorRegion).not.toBeNull();
      expect(indicatorRegion?.className).toContain("max-768:flex");
      expect(indicatorRegion?.parentElement?.className).not.toContain(
        "max-768:hidden",
      );
    } finally {
      restore();
    }
  });
});
