import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
  type TicketListFilterInput,
} from "@/lib/tickets/list-filters";
import type { TicketListItem } from "@/lib/tickets/schemas";
import TicketsPage from "@/features/tickets/TicketsPage";

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const now = new Date();
const minutesAgo = (m: number) =>
  new Date(now.getTime() - m * 60_000).toISOString();
const daysAgo = (d: number) => minutesAgo(d * 24 * 60);

function makeTicket(
  overrides: Partial<TicketListItem> &
    Pick<TicketListItem, "id" | "number" | "title">,
): TicketListItem {
  return {
    projectPath: "/home/alex/github/command-center",
    projectName: "command-center",
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    activeSessionName: null,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(2),
    ...overrides,
  };
}

const TICKETS: TicketListItem[] = [
  makeTicket({
    id: "t-cc-12",
    number: 12,
    title: "Virtualize the attachment index for large dossiers",
    status: "in_progress",
    attachmentCount: 5,
    activeSessionName: "csm/ticket-attachments",
    createdAt: daysAgo(15),
    updatedAt: minutesAgo(4),
  }),
  makeTicket({
    id: "t-cc-9",
    number: 9,
    title: "SSE reconnect drops ticket deltas after laptop sleep",
    workType: "bug",
    status: "not_started",
    attachmentCount: 2,
    createdAt: daysAgo(9),
    updatedAt: minutesAgo(95),
  }),
  makeTicket({
    id: "t-cc-7",
    number: 7,
    title: "Evaluate DuckDB for transcript analytics",
    workType: "research",
    status: "blocked",
    attachmentCount: 3,
    createdAt: daysAgo(21),
    updatedAt: daysAgo(1),
  }),
  makeTicket({
    id: "t-cc-4",
    number: 4,
    title: "Collapse the legacy prompt store into conversation state",
    workType: "tech_debt",
    status: "closed",
    createdAt: daysAgo(40),
    updatedAt: daysAgo(12),
  }),
  makeTicket({
    id: "t-at-5",
    number: 5,
    title: "Interval builder: draggable segment handles",
    projectPath: "/home/alex/github/aerotrainer",
    projectName: "aerotrainer",
    status: "not_started",
    createdAt: daysAgo(3),
    updatedAt: daysAgo(3),
  }),
  makeTicket({
    id: "t-at-3",
    number: 3,
    title: "Workout graph re-renders on every tick",
    projectPath: "/home/alex/github/aerotrainer",
    projectName: "aerotrainer",
    workType: "performance",
    status: "done",
    attachmentCount: 2,
    createdAt: daysAgo(30),
    updatedAt: daysAgo(6),
  }),
];

// ---------------------------------------------------------------------------
// Fetch mocking — serves the list endpoints' contract from the fixture with
// the real shared filter/sort module, so every URL-state combination works.
// ---------------------------------------------------------------------------

function mockTicketFetch(tickets: TicketListItem[]) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const parsed = new URL(url, window.location.origin);

    const projectList = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets$/,
    );
    if (parsed.pathname === "/api/tickets" || projectList) {
      const filters = normalizeTicketListFilters({
        projectName: projectList
          ? decodeURIComponent(projectList[1]!)
          : (parsed.searchParams.get("project") ?? undefined),
        status: (parsed.searchParams.get("status") ??
          undefined) as TicketListFilterInput["status"],
        workType: (parsed.searchParams.get("workType") ??
          undefined) as TicketListFilterInput["workType"],
        sort: (parsed.searchParams.get("sort") ??
          undefined) as TicketListFilterInput["sort"],
      });
      return Response.json(
        sortTicketListItems(
          filters.sort,
          tickets.filter((item) => matchesTicketListFilters(filters, item)),
        ),
      );
    }
    if (parsed.pathname === "/api/projects") {
      return Response.json([
        {
          name: "command-center",
          path: "/home/alex/github/command-center",
          activeSessions: 1,
          hasRunningSession: true,
        },
        {
          name: "aerotrainer",
          path: "/home/alex/github/aerotrainer",
          activeSessions: 0,
          hasRunningSession: false,
        },
      ]);
    }
    if (parsed.pathname === "/api/notifications") {
      return Response.json({
        notifications: [],
        total: 0,
        unreadCount: 0,
      });
    }
    if (parsed.pathname === "/api/conversations/active") {
      return Response.json({
        conversations: [],
        graphWorkflowExecutions: [],
        activeCollaborationExecutions: [],
      });
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function WithTickets({
  tickets,
  children,
}: {
  tickets: TicketListItem[];
  children: React.ReactNode;
}) {
  const cleanup = mockTicketFetch(tickets);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/TicketsPage",
  component: TicketsPage,
  parameters: {
    layout: "fullscreen",
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets" },
    },
  },
  decorators: [
    (Story) => (
      <WithTickets tickets={TICKETS}>
        <Story />
      </WithTickets>
    ),
  ],
} satisfies Meta<typeof TicketsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/** Every ticket across projects, newest update first (the default sort). */
export const Default = {} satisfies Story;

/** `?sort=created` orders by creation time instead of last update. */
export const SortedByCreated = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { sort: "created" } },
    },
  },
} satisfies Story;

/**
 * `?status=not_started` — the filter row reports "n of m shown" and offers
 * Clear filters.
 */
export const FilteredByStatus = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { status: "not_started" } },
    },
  },
} satisfies Story;

/**
 * The project-page entry lands here: `?project=aerotrainer` pre-filters to
 * that project and the project select reflects it.
 */
export const PreFilteredProjectEntry = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { project: "aerotrainer" } },
    },
  },
} satisfies Story;

/** Active filters that match nothing — the no-results empty state. */
export const FilteredNoMatches = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { project: "aerotrainer", status: "blocked" },
      },
    },
  },
} satisfies Story;

/** No tickets exist anywhere — the zero state nudges /ticket creation. */
export const ZeroState = {
  decorators: [
    (Story) => (
      <WithTickets tickets={[]}>
        <Story />
      </WithTickets>
    ),
  ],
} satisfies Story;

/** `?view=board` — the Kanban board presentation of the same filtered set. */
export const BoardView = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { view: "board" } },
    },
  },
} satisfies Story;

/** Compact list rows, non-overlapping page actions, and mobile filter controls. */
export const MobileList = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
} satisfies Story;
