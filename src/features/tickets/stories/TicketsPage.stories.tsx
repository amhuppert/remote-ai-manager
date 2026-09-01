import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { GenericToastSource } from "@/components/ToastHost";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/conversation-policy";
import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
} from "@/lib/tickets/list-filters";
import type {
  TicketDetail,
  TicketListItem,
  TicketStatus,
  TicketWorkType,
} from "@/lib/tickets/schemas";
import TicketsPage from "@/features/tickets/TicketsPage";

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "sonnet", parameters: { effort: "medium" } },
  codex: {
    modelId: "gpt-5.6-sol",
    parameters: { reasoning: "ultra", fast: "false" },
  },
  cursor: { modelId: "composer-2.5", parameters: { fast: "true" } },
};

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

function detailFromListItem(item: TicketListItem): TicketDetail {
  return {
    id: item.id,
    projectPath: item.projectPath,
    projectName: item.projectName,
    number: item.number,
    title: item.title,
    description:
      "The attachment index on ticket detail re-renders every entry on any SSE delta. Virtualize the index list (windowed rendering), keeping keyboard navigation and expand-in-place previews intact.",
    workType: item.workType,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attachments: Array.from({ length: item.attachmentCount }, (_, index) => ({
      id: `${item.id}-att-${index + 1}`,
      ticketId: item.id,
      description: `Context attachment ${index + 1} for ${item.title}.`,
      payload: {
        kind: "note" as const,
        markdown: "## Notes\n- captured from the conversation",
      },
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    })),
    sessions:
      item.activeSessionName === null
        ? []
        : [
            {
              id: `${item.id}-link-1`,
              ticketId: item.id,
              projectPath: item.projectPath,
              sessionName: item.activeSessionName,
              sessionCreatedAt: item.createdAt,
              startMode: "agent" as const,
              linkedAt: item.createdAt,
              endedAt: null,
              endReason: null,
            },
          ],
    relationships: [],
    statusUpdates: { total: 0, recent: [] },
  };
}

// ---------------------------------------------------------------------------
// Fetch mocking — serves the list/detail endpoints' contract from the fixture
// with the real shared filter/sort module, so every URL-state combination and
// the optimistic inline edits behave exactly like the app.
// ---------------------------------------------------------------------------

function mockTicketFetch(initialTickets: TicketListItem[]) {
  let tickets = [...initialTickets];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";
    const parsed = new URL(url, window.location.origin);

    const projectList = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets$/,
    );
    if (
      method === "GET" &&
      (parsed.pathname === "/api/tickets" || projectList)
    ) {
      const statusParam = parsed.searchParams.get("status");
      const filters = normalizeTicketListFilters({
        projectName: projectList
          ? decodeURIComponent(projectList[1]!)
          : (parsed.searchParams.get("project") ?? undefined),
        statuses:
          statusParam === null
            ? undefined
            : (statusParam.split(",") as TicketStatus[]),
        workType: (parsed.searchParams.get("workType") ?? undefined) as
          | TicketWorkType
          | undefined,
        sort:
          parsed.searchParams.get("sort") === "created" ? "created" : "updated",
      });
      return Response.json(
        sortTicketListItems(
          filters.sort,
          tickets.filter((item) => matchesTicketListFilters(filters, item)),
        ),
      );
    }

    const detailMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
    );
    if (detailMatch) {
      const projectName = decodeURIComponent(detailMatch[1]!);
      const number = Number(detailMatch[2]!);
      const index = tickets.findIndex(
        (row) => row.projectName === projectName && row.number === number,
      );
      const item = tickets[index];
      if (item === undefined) {
        return Response.json({ error: "not_found" }, { status: 404 });
      }
      if (method === "GET") return Response.json(detailFromListItem(item));
      if (method === "PATCH") {
        const body =
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as Partial<TicketListItem>)
            : {};
        const next = {
          ...item,
          ...body,
          updatedAt: new Date().toISOString(),
        };
        tickets[index] = next;
        return Response.json(detailFromListItem(next));
      }
      if (method === "DELETE") {
        tickets = tickets.filter((row) => row.id !== item.id);
        return Response.json({
          id: item.id,
          projectPath: item.projectPath,
          projectName: item.projectName,
          number: item.number,
        });
      }
    }

    if (
      method === "GET" &&
      /^\/api\/projects\/([^/]+)\/tickets\/session-links$/.test(parsed.pathname)
    ) {
      return Response.json({});
    }
    if (
      method === "GET" &&
      /^\/api\/specs\/([^/]+)\/ticket-read-through\/(\d+)$/.test(
        parsed.pathname,
      )
    ) {
      return Response.json({ specs: [] });
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
    <QueryClientProvider client={queryClient}>
      {children}
      <GenericToastSource />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/TicketsPage",
  component: TicketsPage,
  args: {
    defaultAgentBackend: "claude",
    backendDefaults: BACKEND_DEFAULTS,
  },
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

/**
 * The default landing: the Kanban board scoped to the OPEN statuses — done
 * and closed columns are filtered out of the default view.
 */
export const Default = {} satisfies Story;

/**
 * `?view=list` — the table presentation. Column headers sort (Updated desc by
 * default); status, type, and title edit inline from the rows.
 */
export const ListView = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { view: "list" } },
    },
  },
} satisfies Story;

/** `?sort=title` — a column sort carried in the URL (title ascending). */
export const ListSortedByTitle = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { view: "list", sort: "title" },
      },
    },
  },
} satisfies Story;

/**
 * `?view=list&t=command-center%2312` — the split screen: the condensed,
 * filter-preserving list on the left and the full ticket dossier on the right.
 */
export const SplitScreenDetail = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { view: "list", t: "command-center#12" },
      },
    },
  },
} satisfies Story;

/** `?status=all` — every status, including the done/closed backlog. */
export const AllStatuses = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { view: "list", status: "all" },
      },
    },
  },
} satisfies Story;

/** `?status=done,closed` — a multi-status set from the checkbox filter. */
export const DoneAndClosedOnly = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { view: "list", status: "done,closed" },
      },
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
        query: { view: "list", project: "aerotrainer", type: "research" },
      },
    },
  },
} satisfies Story;

/** No tickets exist anywhere — the zero state nudges /ticket creation. */
export const ZeroState = {
  parameters: {
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { view: "list" } },
    },
  },
  decorators: [
    (Story) => (
      <WithTickets tickets={[]}>
        <Story />
      </WithTickets>
    ),
  ],
} satisfies Story;

/** Compact list rows, non-overlapping page actions, and mobile filter controls. */
export const MobileList = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/tickets", query: { view: "list" } },
    },
  },
} satisfies Story;

/** Mobile split behavior: the detail pane replaces the list entirely. */
export const MobileDetailPane = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
    nextjs: {
      appDirectory: true,
      navigation: {
        pathname: "/tickets",
        query: { view: "list", t: "command-center#12" },
      },
    },
  },
} satisfies Story;
