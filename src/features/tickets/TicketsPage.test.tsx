// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TicketDetail, TicketListItem } from "@/lib/tickets/schemas";
import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
  type TicketListFilterInput,
} from "@/lib/tickets/list-filters";
import { useToastStoreForTesting } from "@/stores/toast.store";
import { HotkeyProvider } from "@/components/hotkeys/HotkeyProvider";
import {
  createHotkeyDispatcher,
  type HotkeyDispatcher,
} from "@/lib/hotkeys/dispatcher";
import TicketsPage from "./TicketsPage";

const routerReplace = vi.fn();
const routerPush = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPush,
    replace: routerReplace,
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/tickets",
  useSearchParams: () => new URLSearchParams(window.location.search),
}));

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);

const PAGE_PROPS = {
  defaultAgentBackend: "claude",
  backendDefaults: {
    claude: { modelId: "sonnet", effort: "medium" },
    codex: { modelId: "gpt-5.6-sol", effort: "ultra" },
    cursor: { modelId: "composer-2.5", effort: "high" },
  },
} as const;

function ticket(overrides: Partial<TicketListItem>): TicketListItem {
  return {
    id: "id-cc-12",
    projectPath: "/repos/command-center",
    projectName: "command-center",
    number: 12,
    title: "Virtualize the attachment index",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 5,
    activeSessionName: null,
    createdAt: "2026-06-25T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
    ...overrides,
  };
}

const TICKETS: TicketListItem[] = [
  ticket({
    id: "id-cc-12",
    number: 12,
    title: "Virtualize the attachment index",
    workType: "feature",
    status: "in_progress",
    attachmentCount: 5,
    activeSessionName: "csm/ticket-attachments",
    createdAt: "2026-06-25T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
  }),
  ticket({
    id: "id-cc-9",
    number: 9,
    title: "SSE reconnect drops ticket deltas",
    workType: "bug",
    status: "not_started",
    attachmentCount: 2,
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-10T08:00:00.000Z",
  }),
  ticket({
    id: "id-at-5",
    projectPath: "/repos/aerotrainer",
    projectName: "aerotrainer",
    number: 5,
    title: "Interval builder: draggable segment handles",
    workType: "feature",
    status: "not_started",
    attachmentCount: 0,
    createdAt: "2026-07-09T10:00:00.000Z",
    updatedAt: "2026-07-09T10:00:00.000Z",
  }),
  ticket({
    id: "id-at-3",
    projectPath: "/repos/aerotrainer",
    projectName: "aerotrainer",
    number: 3,
    title: "Workout graph re-renders on every tick",
    workType: "performance",
    status: "done",
    attachmentCount: 2,
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-07-05T10:00:00.000Z",
  }),
];

function detailFor(item: TicketListItem): TicketDetail {
  return {
    id: item.id,
    projectPath: item.projectPath,
    projectName: item.projectName,
    number: item.number,
    title: item.title,
    description: "A detailed description of the work.",
    workType: item.workType,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attachments: [],
    sessions: [],
  };
}

interface FetchLogEntry {
  url: string;
  method: string;
  body: unknown;
}

interface DeleteFailureController {
  pending: Array<(response: Response) => void>;
  defer: boolean;
}

interface FetchStubOptions {
  failTotalsOnce?: boolean;
  failFilteredOnce?: boolean;
}

/**
 * Serves the real list/detail endpoints' contract from an in-memory fixture:
 * list URLs filter and sort per the request params (comma-separated status
 * sets included), PATCH updates the fixture, so a page that ignores its URL
 * state gets the wrong rows back.
 */
function installFetchStub(
  initialTickets: TicketListItem[],
  deleteFailures?: DeleteFailureController,
  options: FetchStubOptions = {},
): FetchLogEntry[] {
  // Own copy: mutations change the served fixture, and the module-level
  // ticket arrays are shared across tests.
  const tickets = [...initialTickets];
  const log: FetchLogEntry[] = [];
  let totalsFailuresLeft = options.failTotalsOnce ? 1 : 0;
  let filteredFailuresLeft = options.failFilteredOnce ? 1 : 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? "GET";
      const body =
        typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      log.push({ url, method, body });
      const parsed = new URL(url, "http://localhost");

      const globalList = parsed.pathname === "/api/tickets";
      const projectList = parsed.pathname.match(
        /^\/api\/projects\/([^/]+)\/tickets$/,
      );
      if (method === "GET" && (globalList || projectList)) {
        const statusParam = parsed.searchParams.get("status");
        const isTotalsRequest =
          globalList &&
          parsed.searchParams.get("sort") === "updated" &&
          parsed.searchParams.get("project") === null &&
          statusParam === null &&
          parsed.searchParams.get("workType") === null;
        if (isTotalsRequest && totalsFailuresLeft > 0) {
          totalsFailuresLeft -= 1;
          return Response.json(
            { error: "totals_unavailable" },
            { status: 503 },
          );
        }
        if (!isTotalsRequest && filteredFailuresLeft > 0) {
          filteredFailuresLeft -= 1;
          return Response.json(
            { error: "tickets_unavailable" },
            { status: 503 },
          );
        }
        const filters = normalizeTicketListFilters({
          projectName: projectList
            ? decodeURIComponent(projectList[1]!)
            : (parsed.searchParams.get("project") ?? undefined),
          statuses:
            statusParam === null
              ? undefined
              : (statusParam.split(",") as NonNullable<
                  TicketListFilterInput["statuses"]
                >[number][]),
          workType: (parsed.searchParams.get("workType") ??
            undefined) as TicketListFilterInput["workType"],
          sort: (parsed.searchParams.get("sort") ??
            undefined) as TicketListFilterInput["sort"],
        });
        const rows = sortTicketListItems(
          filters.sort,
          tickets.filter((item) => matchesTicketListFilters(filters, item)),
        );
        return Response.json(rows);
      }

      const identityMatch = parsed.pathname.match(
        /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
      );
      if (identityMatch) {
        const projectName = decodeURIComponent(identityMatch[1]!);
        const number = Number(identityMatch[2]!);
        const index = tickets.findIndex(
          (row) => row.projectName === projectName && row.number === number,
        );
        if (method === "GET") {
          const item = tickets[index];
          if (item === undefined) {
            return Response.json({ error: "not_found" }, { status: 404 });
          }
          return Response.json(detailFor(item));
        }
        if (method === "PATCH") {
          const item = tickets[index];
          if (item === undefined) {
            return Response.json({ error: "not_found" }, { status: 404 });
          }
          const updated: TicketListItem = {
            ...item,
            ...(body as Partial<TicketListItem>),
            updatedAt: new Date().toISOString(),
          };
          tickets[index] = updated;
          return Response.json(detailFor(updated));
        }
        if (method === "DELETE") {
          if (deleteFailures?.defer) {
            return await new Promise<Response>((resolve) => {
              deleteFailures.pending.push(resolve);
            });
          }
          const item = index === -1 ? undefined : tickets[index];
          // Serve the endpoint's real contract: the row is gone from every
          // later list response, so a post-invalidation refetch cannot
          // resurrect an optimistically removed ticket.
          if (index !== -1) tickets.splice(index, 1);
          return Response.json({
            id: item?.id ?? "deleted",
            projectPath: item?.projectPath ?? "/repos/unknown",
            projectName,
            number,
          });
        }
      }

      if (
        method === "GET" &&
        /^\/api\/projects\/([^/]+)\/tickets\/session-links$/.test(
          parsed.pathname,
        )
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

      return Response.json({ error: "not found" }, { status: 404 });
    },
  );
  return log;
}

function renderPage(search = "", dispatcher?: HotkeyDispatcher) {
  window.history.replaceState(null, "", `/tickets${search}`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  const page = (
    <QueryClientProvider client={queryClient}>
      <TicketsPage {...PAGE_PROPS} />
    </QueryClientProvider>
  );
  return render(
    dispatcher === undefined ? (
      page
    ) : (
      <HotkeyProvider dispatcher={dispatcher}>{page}</HotkeyProvider>
    ),
  );
}

function rowTitles(): string[] {
  return screen
    .queryAllByRole("row")
    .map((row) => row.getAttribute("data-ticket-title"))
    .filter((title): title is string => title !== null);
}

beforeEach(() => {
  routerReplace.mockClear();
  routerPush.mockClear();
  useToastStoreForTesting.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TicketsPage defaults", () => {
  it("lands on the board with done and closed filtered out", async () => {
    installFetchStub(TICKETS);
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Not Started column" }),
      ).toBeInTheDocument(),
    );
    // Board cards, not list rows; the done ticket is hidden by default.
    expect(rowTitles()).toEqual([]);
    expect(screen.getByText("command-center#12")).toBeInTheDocument();
    expect(screen.queryByText("aerotrainer#3")).not.toBeInTheDocument();
    expect(screen.getByText("3 of 4 shown")).toBeInTheDocument();
  });
});

describe("TicketsPage list view", () => {
  it("hides done/closed by default and reports n of m shown", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Virtualize the attachment index",
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
    ]);
    expect(screen.getByText("3 of 4 shown")).toBeInTheDocument();
    // Row anatomy: id, type control, status control, session pill.
    const row = screen
      .getByText("command-center#12")
      .closest("[data-ticket-title]")!;
    expect(within(row as HTMLElement).getByText("feature")).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText("In Progress"),
    ).toBeInTheDocument();
    expect(
      within(row as HTMLElement).getByText("csm/ticket-attachments"),
    ).toBeInTheDocument();
  });

  it("shows every ticket for status=all, newest update first", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&status=all");

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Virtualize the attachment index",
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
      "Workout graph re-renders on every tick",
    ]);
    expect(screen.getByText("4 of 4 shown")).toBeInTheDocument();
  });

  it("filters by a multi-status set from the URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&status=not_started,done");

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
      "Workout graph re-renders on every tick",
    ]);
    expect(screen.getByText("3 of 4 shown")).toBeInTheDocument();
  });

  it("pre-filters to the project named in the URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&project=aerotrainer");

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Interval builder: draggable segment handles",
    ]);
    expect(screen.queryByText("command-center#12")).not.toBeInTheDocument();
    expect(screen.getByText("1 of 4 shown")).toBeInTheDocument();
    // The project select reflects the pre-filter.
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent(
      "aerotrainer",
    );
  });

  it("adds a status through the checkbox filter menu", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Status filter" }));
    await user.click(
      await screen.findByRole("menuitemcheckbox", { name: "Done" }),
    );

    expect(routerReplace).toHaveBeenCalledWith(
      "/tickets?view=list&status=not_started%2Cin_progress%2Cdone%2Cblocked",
      { scroll: false },
    );
  });

  it("switches to every status via the menu's All statuses shortcut", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Status filter" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "All statuses" }),
    );

    expect(routerReplace).toHaveBeenCalledWith(
      "/tickets?view=list&status=all",
      { scroll: false },
    );
  });

  it("can filter a project whose name is the all-projects sentinel text", async () => {
    installFetchStub([
      ...TICKETS,
      ticket({
        id: "id-all-1",
        projectPath: "/repos/all",
        projectName: "all",
        number: 1,
        title: "Literal all project",
        status: "not_started",
      }),
    ]);
    renderPage("?view=list");
    const user = userEvent.setup();

    await screen.findByText("all#1");
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: /^all$/ }));

    expect(routerReplace).toHaveBeenCalledWith(
      "/tickets?view=list&project=all",
      {
        scroll: false,
      },
    );
  });

  it("shows Clear filters only while filters are active and resets to the defaults", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&status=done&type=performance");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#3")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerReplace).toHaveBeenCalledWith("/tickets?view=list", {
      scroll: false,
    });
  });

  it("omits Clear filters when the filters sit at the defaults", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Clear filters" }),
    ).not.toBeInTheDocument();
  });

  it("shows the no-results empty state when filters exclude everything", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&status=blocked");

    await waitFor(() =>
      expect(
        screen.getByText("No tickets match these filters"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("0 of 4 shown")).toBeInTheDocument();
  });

  it("keeps filtered rows visible and restores totals after a retry", async () => {
    installFetchStub(TICKETS, undefined, { failTotalsOnce: true });
    renderPage("?view=list&status=not_started");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    expect(screen.getByText("aerotrainer#5")).toBeInTheDocument();
    expect(screen.queryByText("2 of 4 shown")).not.toBeInTheDocument();

    const warning = await screen.findByRole("alert");
    expect(warning).toHaveTextContent("ticket totals");
    await user.click(
      within(warning).getByRole("button", { name: "Retry totals" }),
    );

    await waitFor(() =>
      expect(screen.getByText("2 of 4 shown")).toBeInTheDocument(),
    );
    expect(screen.getByText("4 tickets")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retries the primary ticket list after a load failure", async () => {
    installFetchStub(TICKETS, undefined, { failFilteredOnce: true });
    renderPage("?view=list&status=not_started");
    const user = userEvent.setup();

    const failure = await screen.findByRole("alert");
    expect(failure).toHaveTextContent("Couldn't load tickets");
    await user.click(
      within(failure).getByRole("button", { name: "Retry tickets" }),
    );

    expect(await screen.findByText("command-center#9")).toBeInTheDocument();
  });

  it("shows the zero state when no tickets exist at all", async () => {
    installFetchStub([]);
    renderPage("?view=list");

    await waitFor(() =>
      expect(screen.getByText("No tickets yet")).toBeInTheDocument(),
    );
    expect(screen.getByText("/ticket").parentElement).toHaveTextContent(
      "in a project or session conversation",
    );
    expect(
      screen.queryByText("No tickets match these filters"),
    ).not.toBeInTheDocument();
  });
});

describe("TicketsPage column sort", () => {
  it("sorts rows by a column carried in the URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&sort=title&dir=asc&status=all");

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Interval builder: draggable segment handles",
      "SSE reconnect drops ticket deltas",
      "Virtualize the attachment index",
      "Workout graph re-renders on every tick",
    ]);
    const titleHeader = screen.getByRole("columnheader", { name: /Title/ });
    expect(titleHeader).toHaveAttribute("aria-sort", "ascending");
  });

  it("activates a column with its natural direction on header click", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Title/ }));
    expect(routerReplace).toHaveBeenCalledWith(
      "/tickets?view=list&sort=title&dir=asc",
      { scroll: false },
    );
  });

  it("flips the direction when the active column is clicked again", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&sort=title&dir=asc");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: /^Title/ }));
    expect(routerReplace).toHaveBeenCalledWith(
      "/tickets?view=list&sort=title&dir=desc",
      { scroll: false },
    );
  });
});

describe("TicketsPage inline editing", () => {
  it("changes a ticket's status from the list row", async () => {
    const log = installFetchStub(TICKETS);
    renderPage("?view=list&status=all");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Status for command-center#9" }),
    );
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await waitFor(() =>
      expect(
        log.some(
          (entry) =>
            entry.method === "PATCH" &&
            entry.url.includes("/api/projects/command-center/tickets/9") &&
            (entry.body as { status?: string }).status === "done",
        ),
      ).toBe(true),
    );
    // Optimistic: the row's status control reflects Done immediately.
    const row = screen
      .getByText("command-center#9")
      .closest("[data-ticket-title]") as HTMLElement;
    expect(
      within(row).getByRole("combobox", {
        name: "Status for command-center#9",
      }),
    ).toHaveTextContent("Done");
  });

  it("changes a ticket's type from the list row", async () => {
    const log = installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Type for command-center#9" }),
    );
    await user.click(await screen.findByRole("option", { name: "Tech debt" }));

    await waitFor(() =>
      expect(
        log.some(
          (entry) =>
            entry.method === "PATCH" &&
            entry.url.includes("/api/projects/command-center/tickets/9") &&
            (entry.body as { workType?: string }).workType === "tech_debt",
        ),
      ).toBe(true),
    );
  });

  it("renames a ticket inline via the pencil, committing on Enter", async () => {
    const log = installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit title of command-center#9" }),
    );
    const input = screen.getByRole("textbox", {
      name: /Title of command-center#9/,
    });
    await user.clear(input);
    await user.type(input, "Harden SSE reconnect{Enter}");

    await waitFor(() =>
      expect(
        log.some(
          (entry) =>
            entry.method === "PATCH" &&
            (entry.body as { title?: string }).title === "Harden SSE reconnect",
        ),
      ).toBe(true),
    );
    expect(screen.getByText("Harden SSE reconnect")).toBeInTheDocument();
  });

  it("cancels an inline rename on Escape without a request", async () => {
    const log = installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", { name: "Edit title of command-center#9" }),
    );
    await user.keyboard("{Escape}");

    expect(
      screen.getByText("SSE reconnect drops ticket deltas"),
    ).toBeInTheDocument();
    expect(log.some((entry) => entry.method === "PATCH")).toBe(false);
  });
});

describe("TicketsPage split screen", () => {
  it("opens the detail pane from the URL while keeping the condensed list", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&t=command-center%2312");

    const pane = await screen.findByRole("region", {
      name: "Ticket detail: command-center#12",
    });
    await waitFor(() =>
      expect(
        within(pane).getByText("A detailed description of the work."),
      ).toBeInTheDocument(),
    );
    // The condensed list keeps every filtered row and marks the selection.
    expect(rowTitles()).toEqual([
      "Virtualize the attachment index",
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
    ]);
    const selectedRow = document.querySelector(
      '[data-ticket-title="Virtualize the attachment index"]',
    );
    expect(selectedRow).toHaveAttribute("data-selected");
  });

  it("selects a ticket on row click, pushing the split URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const row = screen
      .getByText("command-center#9")
      .closest("[data-ticket-title]") as HTMLElement;
    await user.click(row);

    expect(routerPush).toHaveBeenCalledWith(
      "/tickets?view=list&t=command-center%239",
      { scroll: false },
    );
  });

  it("closes the pane, dropping only the selection from the URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&status=all&t=command-center%2312");
    const user = userEvent.setup();

    await screen.findByRole("region", {
      name: "Ticket detail: command-center#12",
    });
    await user.click(
      screen.getByRole("button", { name: "Close ticket detail" }),
    );

    expect(routerPush).toHaveBeenCalledWith("/tickets?view=list&status=all", {
      scroll: false,
    });
  });

  it("shows the never-reused explanation when the selected ticket is missing", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list&t=command-center%23999");

    await screen.findByRole("region", {
      name: "Ticket detail: command-center#999",
    });
    expect(
      await screen.findByText("command-center#999 doesn't exist"),
    ).toBeInTheDocument();
  });
});

describe("TicketsPage view switch", () => {
  it("opens the mobile board pager on the status selected by the URL filter", async () => {
    installFetchStub(TICKETS);
    renderPage("?status=in_progress");

    await screen.findByText("command-center#12");
    expect(
      screen.getByRole("button", { name: /^In Progress/ }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("pushes the list URL when the segmented control switches views", async () => {
    installFetchStub(TICKETS);
    renderPage("?project=aerotrainer");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "List" }));
    expect(routerPush).toHaveBeenCalledWith(
      "/tickets?view=list&project=aerotrainer",
      { scroll: false },
    );
  });

  it("switches between board and list with V B and V L", async () => {
    installFetchStub(TICKETS);
    const listDispatcher = createHotkeyDispatcher();
    const listRender = renderPage(
      "?view=list&project=aerotrainer",
      listDispatcher,
    );

    await screen.findByText("aerotrainer#5");
    expect(
      listDispatcher
        .getCommands()
        .find((command) => command.definition.id === "viewBoard")?.available,
    ).toBe(true);
    expect(
      listDispatcher
        .getCommands()
        .find((command) => command.definition.id === "viewList")?.available,
    ).toBe(false);

    fireEvent.keyDown(document, { key: "v" });
    fireEvent.keyDown(document, { key: "b" });
    expect(routerPush).toHaveBeenCalledWith("/tickets?project=aerotrainer", {
      scroll: false,
    });

    listRender.unmount();
    routerPush.mockClear();
    const boardDispatcher = createHotkeyDispatcher();
    renderPage("?project=aerotrainer", boardDispatcher);
    await screen.findByText("aerotrainer#5");

    fireEvent.keyDown(document, { key: "v" });
    fireEvent.keyDown(document, { key: "l" });
    expect(routerPush).toHaveBeenCalledWith(
      "/tickets?view=list&project=aerotrainer",
      { scroll: false },
    );
  });
});

describe("TicketsPage row actions", () => {
  it("copies the canonical ticket reference from the kebab", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();
    // userEvent.setup() installs its own navigator.clipboard stub, so the spy
    // must replace it after setup or writeText lands on userEvent's copy.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    const row = screen
      .getByText("command-center#12")
      .closest("[data-ticket-title]") as HTMLElement;
    await user.click(
      within(row).getByRole("button", {
        name: "Ticket actions for command-center#12",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Copy ticket reference" }),
    );

    expect(writeText).toHaveBeenCalledWith(
      '<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Virtualize the attachment index" read-command="cctl ticket get &apos;command-center#12&apos;" />',
    );
  });

  it("deletes a ticket only after the confirmation dialog is accepted", async () => {
    const log = installFetchStub(TICKETS);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const row = screen
      .getByText("command-center#9")
      .closest("[data-ticket-title]") as HTMLElement;
    await user.click(
      within(row).getByRole("button", {
        name: "Ticket actions for command-center#9",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete ticket…" }),
    );

    // Nothing deleted until the dialog confirms.
    expect(log.some((entry) => entry.method === "DELETE")).toBe(false);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).toHaveTextContent("command-center#9");

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        log.some(
          (entry) =>
            entry.method === "DELETE" &&
            entry.url.includes("/api/projects/command-center/tickets/9"),
        ),
      ).toBe(true),
    );
    // Optimistic removal starts immediately, retaining the row only for the
    // 150ms collapse-out before it leaves the live list.
    expect(
      screen.getByText("command-center#9").closest("[data-ticket-title]")
        ?.className,
    ).toContain("animate-tk-sse-out");
    await waitFor(() =>
      expect(screen.queryByText("command-center#9")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", {
        name: "Ticket actions for aerotrainer#5",
      }),
    );
  });

  it("reports each failed delete when rapid list actions overlap", async () => {
    const deleteFailures: DeleteFailureController = {
      pending: [],
      defer: true,
    };
    installFetchStub(TICKETS, deleteFailures);
    renderPage("?view=list");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const remove = async (identifier: string) => {
      const row = screen
        .getByText(identifier)
        .closest("[data-ticket-title]") as HTMLElement;
      await user.click(
        within(row).getByRole("button", {
          name: `Ticket actions for ${identifier}`,
        }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Delete ticket…" }),
      );
      const dialog = await screen.findByRole("alertdialog");
      await user.click(within(dialog).getByRole("button", { name: "Delete" }));
      await waitFor(() =>
        expect(document.querySelector('[role="alertdialog"]')).toBeNull(),
      );
    };

    await remove("command-center#9");
    await waitFor(() => expect(deleteFailures.pending).toHaveLength(1));
    await remove("aerotrainer#5");
    await waitFor(() => expect(deleteFailures.pending).toHaveLength(2));

    await act(async () => {
      deleteFailures.pending[0]!(
        Response.json({ error: "delete_failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      deleteFailures.pending[1]!(
        Response.json({ error: "delete_failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      const messages = useToastStoreForTesting
        .getState()
        .toasts.map((toast) => toast.message);
      expect(
        messages.some((message) => message.includes("command-center#9")),
      ).toBe(true);
      expect(
        messages.some((message) => message.includes("aerotrainer#5")),
      ).toBe(true);
    });
  });
});
