import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import ToastContainer from "@/components/ToastContainer";
import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
} from "@/lib/tickets/list-filters";
import { useTicketListQuery } from "@/lib/tickets/queries";
import type { TicketDetail, TicketListItem } from "@/lib/tickets/schemas";
import TicketBoard from "@/features/tickets/components/TicketBoard";

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

const FULL_BOARD: TicketListItem[] = [
  makeTicket({
    id: "t-cc-9",
    number: 9,
    title: "SSE reconnect drops ticket deltas",
    workType: "bug",
    attachmentCount: 2,
    updatedAt: minutesAgo(30),
  }),
  makeTicket({
    id: "t-at-5",
    number: 5,
    projectPath: "/home/alex/github/aerotrainer",
    projectName: "aerotrainer",
    title: "Interval builder: draggable segment handles",
    updatedAt: daysAgo(1),
  }),
  makeTicket({
    id: "t-cc-12",
    number: 12,
    title: "Virtualize the attachment index",
    status: "in_progress",
    attachmentCount: 5,
    activeSessionName: "csm/ticket-attachments",
    updatedAt: minutesAgo(4),
  }),
  makeTicket({
    id: "t-at-3",
    number: 3,
    projectPath: "/home/alex/github/aerotrainer",
    projectName: "aerotrainer",
    title: "Workout graph re-renders on every tick",
    workType: "performance",
    status: "done",
    attachmentCount: 2,
    updatedAt: daysAgo(5),
  }),
  makeTicket({
    id: "t-cc-7",
    number: 7,
    title: "Evaluate DuckDB for transcript analytics",
    workType: "research",
    status: "blocked",
    attachmentCount: 3,
    updatedAt: daysAgo(1),
  }),
  makeTicket({
    id: "t-cc-4",
    number: 4,
    title: "Collapse the legacy prompt store into conversation state",
    workType: "tech_debt",
    status: "closed",
    updatedAt: daysAgo(12),
  }),
];

const LONG_TITLES: TicketListItem[] = [
  makeTicket({
    id: "t-long-1",
    number: 21,
    title:
      "Investigate why the conversation transcript virtualizer thrashes layout when a mermaid diagram, three collapsed tool-use blocks, and a full-width image land in the same viewport slice",
    workType: "research",
    attachmentCount: 7,
  }),
  makeTicket({
    id: "t-long-2",
    number: 22,
    title:
      "The workflow builder inspector rail should keep the focus sheet scroll position across tab switches even when the underlying node is re-materialized by an SSE delta",
    status: "in_progress",
    activeSessionName: "csm/very-long-session-branch-name-that-truncates",
    updatedAt: minutesAgo(10),
  }),
];

// ---------------------------------------------------------------------------
// Harness — mirrors the production wiring: the board renders from the query
// cache, so optimistic moves (and rollbacks) behave exactly like the app.
// ---------------------------------------------------------------------------

function detailFor(item: TicketListItem): TicketDetail {
  return {
    id: item.id,
    projectPath: item.projectPath,
    projectName: item.projectName,
    number: item.number,
    title: item.title,
    description: "",
    workType: item.workType,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attachments: [],
    sessions: [],
  };
}

function mockBoardFetch(tickets: TicketListItem[], failMoves: boolean) {
  const served = [...tickets];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method?.toUpperCase() ?? "GET";
    const parsed = new URL(url, window.location.origin);

    if (method === "GET" && parsed.pathname === "/api/tickets") {
      const filters = normalizeTicketListFilters({});
      return Response.json(
        sortTicketListItems(
          filters.sort,
          served.filter((item) => matchesTicketListFilters(filters, item)),
        ),
      );
    }
    const patchMatch = parsed.pathname.match(
      /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
    );
    if (method === "PATCH" && patchMatch) {
      if (failMoves) {
        return Response.json({ error: "update_failed" }, { status: 500 });
      }
      const projectName = decodeURIComponent(patchMatch[1]!);
      const number = Number(patchMatch[2]!);
      const index = served.findIndex(
        (row) => row.projectName === projectName && row.number === number,
      );
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      served[index] = {
        ...served[index]!,
        ...body,
        updatedAt: new Date().toISOString(),
      };
      return Response.json(detailFor(served[index]!));
    }
    return original(input, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

function BoardFromQuery(): React.JSX.Element {
  const listQuery = useTicketListQuery({});
  return <TicketBoard items={listQuery.data ?? []} />;
}

function BoardHarness({
  tickets,
  failMoves = false,
}: {
  tickets: TicketListItem[];
  failMoves?: boolean;
}): React.JSX.Element {
  const cleanup = mockBoardFetch(tickets, failMoves);
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", cleanup, { once: true });
  }
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-[480px] bg-bg-void">
        <BoardFromQuery />
      </div>
      <ToastContainer />
    </QueryClientProvider>
  );
}

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

const meta = {
  title: "Tickets/TicketBoard",
  component: TicketBoard,
  // Stories render through BoardHarness (query-cache-backed, like the app);
  // meta-level args only satisfy the component's required-prop contract.
  args: { items: FULL_BOARD },
  parameters: {
    layout: "fullscreen",
    nextjs: { appDirectory: true, navigation: { pathname: "/tickets" } },
  },
} satisfies Meta<typeof TicketBoard>;

export default meta;
type Story = StoryObj<typeof meta>;

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

/**
 * All five status columns populated. Drag a card between columns (pickup
 * lift, target highlight with count preview, commit wash) or use the kebab's
 * Move-to radio group.
 */
export const FiveColumns: Story = {
  render: () => <BoardHarness tickets={FULL_BOARD} />,
};

/** Only Not Started holds cards — the other wells invite a drop. */
export const EmptyColumns: Story = {
  render: () => (
    <BoardHarness
      tickets={FULL_BOARD.filter((t) => t.status === "not_started")}
    />
  ),
};

/** Two-line clamp on long titles; truncated session names. */
export const LongTitles: Story = {
  render: () => <BoardHarness tickets={LONG_TITLES} />,
};

/**
 * Keyboard protocol: Tab to a card's drag handle, Space picks it up, ←/→ move
 * it between columns (↑/↓ within one), Space drops, Esc cancels — every step
 * announced via aria-live.
 */
export const KeyboardMovement: Story = {
  render: () => <BoardHarness tickets={FULL_BOARD} />,
  play: async ({ canvasElement }) => {
    const handle = canvasElement.querySelector<HTMLElement>(
      "button[aria-label='Drag command-center#9']",
    );
    handle?.focus();
  },
};

/**
 * Every move is rejected by the server: the card snaps back with a 1.5s red
 * ring and a toast names the ticket and the failed target, with a Retry
 * action that re-issues the move.
 */
export const MoveFails: Story = {
  render: () => <BoardHarness tickets={FULL_BOARD} failMoves />,
};

/** Mobile status pager with one reachable column and always-visible Move-to controls. */
export const MobilePager: Story = {
  render: () => <BoardHarness tickets={FULL_BOARD} />,
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
