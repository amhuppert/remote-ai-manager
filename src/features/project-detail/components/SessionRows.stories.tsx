import type { ComponentType, JSX } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionListItem } from "@/lib/sessions/schemas";
import type { TicketLinkSummary } from "@/lib/tickets/schemas";
import SessionRows from "./SessionRows";

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

const sampleSessions: SessionListItem[] = [
  makeSession({
    sessionName: "implement-auth",
    branchName: "csm/implement-auth",
    lastActivityAt: now,
  }),
  makeSession({
    sessionName: "add-dashboard",
    branchName: "csm/add-dashboard",
    creationMode: "normal",
    lastActivityAt: hourAgo,
  }),
  makeSession({
    sessionName: "fix-nav-bug",
    branchName: "csm/fix-nav-bug",
    targetBranch: "csm/implement-auth",
    parentSessionName: "implement-auth",
    creationMode: "optimistic",
    lastActivityAt: hourAgo,
  }),
  makeSession({
    sessionName: "refactor-api",
    branchName: "csm/refactor-api",
    finished: true,
    lastActivityAt: dayAgo,
  }),
  makeSession({
    sessionName: "child-of-dashboard",
    branchName: "csm/child-of-dashboard",
    targetBranch: "csm/add-dashboard",
    parentSessionName: "add-dashboard",
    lastActivityAt: now,
  }),
];

const meta = {
  title: "Sessions/SessionRows",
  component: SessionRows,
  args: {
    sessions: sampleSessions,
    projectName: "my-app",
    sort: { id: "lastActivityAt", desc: true },
    onSortChange: fn(),
    selection: new Set<string>(),
    onToggleSelect: fn(),
    onToggleAll: fn(),
    onBranch: fn(),
  },
  decorators: [
    (Story) => (
      <div className="p-xl max-768:p-0">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SessionRows>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Default rows with mixed main/child sessions */
export const Default = {
  args: {},
} satisfies Story;

/** All sessions targeting main */
export const AllMainTargets = {
  args: {
    sessions: sampleSessions.filter((s) => s.targetBranch === "main"),
  },
} satisfies Story;

/** Sessions with non-main targets highlighted */
export const ChildSessions = {
  args: {
    sessions: sampleSessions.filter((s) => s.targetBranch !== "main"),
  },
} satisfies Story;

/**
 * An archived row above a normal row. Archived rows are dimmed, but the dim must
 * not wrap the open kebab popup: open the archived row's menu and it must be fully
 * opaque and paint above the next row's controls (e.g. its TDD toggle).
 */
export const Archived = {
  args: {
    sessions: [
      makeSession({
        sessionName: "archived-experiment",
        branchName: "csm/archived-experiment",
        archived: true,
        lastActivityAt: now,
      }),
      makeSession({
        sessionName: "active-below",
        branchName: "csm/active-below",
        lastActivityAt: hourAgo,
      }),
    ],
  },
} satisfies Story;

// ---------------------------------------------------------------------------
// Ticket indicators — the per-project session-link map drives an identifier
// pill after the session name (active = cyan, historical = muted).
// ---------------------------------------------------------------------------

const TICKET_LINKS: Record<string, TicketLinkSummary> = {
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

function mockSessionLinksFetch() {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname === "/api/projects/my-app/tickets/session-links") {
      return Response.json(TICKET_LINKS);
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

/**
 * Ticket-linked sessions: `implement-auth` carries an active (cyan) pill for
 * my-app#12, `refactor-api` a muted historical pill for my-app#7; unlinked
 * rows carry none. Clicking a pill navigates to the ticket's detail view.
 */
export const TicketLinked = {
  args: {},
  decorators: [
    (Story: ComponentType): JSX.Element => {
      const cleanup = mockSessionLinksFetch();
      if (typeof window !== "undefined") {
        window.addEventListener("beforeunload", cleanup, { once: true });
      }
      return <Story />;
    },
  ],
} satisfies Story;

/** Empty rows */
export const Empty = {
  args: {
    sessions: [],
  },
} satisfies Story;

/** Without onBranch — Branch kebab option still renders, just no-ops */
export const NoBranchAction = {
  args: {
    onBranch: undefined,
  },
} satisfies Story;

/**
 * Mobile viewport (≤768px). Selection and sorting lead the list. Session names
 * and branches wrap; status, target, activity, TDD and the conversation shortcut
 * are available in Session details.
 */
export const Mobile = {
  args: {},
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
  decorators: [
    (Story: ComponentType): JSX.Element => (
      <div style={{ width: "100%", maxWidth: 375 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Story;
