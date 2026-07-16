// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import { renderWithQuery } from "@/test/component-mocks";
import SessionRows from "./SessionRows";

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

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const dayAgo = new Date(Date.now() - 86_400_000).toISOString();

function makeSession(
  overrides: Partial<SessionListItem> &
    Pick<SessionListItem, "sessionName" | "branchName">,
): SessionListItem {
  return {
    worktreePath: `/tmp/wt/${overrides.sessionName}`,
    createdAt: dayAgo,
    lastActivityAt: hourAgo,
    archived: false,
    finished: false,
    source: "cc",
    creationMode: "normal",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    derivedStatus: "idle",
    promptCount: 0,
    derivedLastActivityAt: hourAgo,
    collabContribution: null,
    hasActiveGraphWorkflow: false,
    ...overrides,
  };
}

const sessions = [
  makeSession({
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    lastActivityAt: now,
  }),
  makeSession({
    sessionName: "add-dashboard",
    branchName: "csm/add-dashboard",
  }),
  makeSession({
    sessionName: "refactor-api",
    branchName: "csm/refactor-api",
    finished: true,
    lastActivityAt: dayAgo,
  }),
];

const ticketLinks: Record<string, TicketLinkSummary> = {
  "implement-auth": {
    ticketId: "t-1",
    projectName: "my-app",
    number: 12,
    title: "Harden the auth flow",
    active: true,
    linkedAt: hourAgo,
    endedAt: null,
  },
  "refactor-api": {
    ticketId: "t-2",
    projectName: "my-app",
    number: 7,
    title: "Collapse the v1 API shims",
    active: false,
    linkedAt: dayAgo,
    endedAt: hourAgo,
  },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function rowFor(sessionName: string): HTMLElement {
  const row = screen
    .getByRole("link", { name: sessionName })
    .closest('[data-testid="session-card"]');
  if (!(row instanceof HTMLElement)) {
    throw new Error(`no session row for ${sessionName}`);
  }
  return row;
}

describe("SessionRows", () => {
  it("shows identifier pills for active and historical ticket links", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (
        new URL(url, window.location.origin).pathname ===
        "/api/projects/my-app/tickets/session-links"
      ) {
        return Response.json(ticketLinks);
      }
      return originalFetch(input);
    });

    renderWithQuery(
      <SessionRows
        sessions={sessions}
        projectName="my-app"
        sort={{ id: "lastActivityAt", desc: true }}
        onSortChange={vi.fn()}
        selection={new Set<string>()}
        onToggleSelect={vi.fn()}
        onToggleAll={vi.fn()}
        onBranch={vi.fn()}
      />,
    );

    const activePill = await waitFor(() =>
      within(rowFor("implement-auth")).getByRole("link", {
        name: "my-app#12",
      }),
    );
    expect(activePill).toHaveAttribute("href", "/tickets/my-app/12");
    expect(activePill).toHaveAttribute("data-active");

    const endedPill = within(rowFor("refactor-api")).getByRole("link", {
      name: "my-app#7",
    });
    expect(endedPill).toHaveAttribute("href", "/tickets/my-app/7");
    expect(endedPill).not.toHaveAttribute("data-active");

    expect(
      within(rowFor("add-dashboard")).queryByRole("link", {
        name: /my-app#/,
      }),
    ).not.toBeInTheDocument();
  });
});
