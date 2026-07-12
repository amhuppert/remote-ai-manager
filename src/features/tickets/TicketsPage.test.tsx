// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TicketListItem } from "@/lib/tickets/schemas";
import {
  matchesTicketListFilters,
  normalizeTicketListFilters,
  sortTicketListItems,
  type TicketListFilterInput,
} from "@/lib/tickets/list-filters";
import { useToastStoreForTesting } from "@/stores/toast.store";
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

interface FetchLogEntry {
  url: string;
  method: string;
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
 * Serves the real list endpoints' contract from an in-memory fixture: both
 * the global and project-scoped list URLs filter and sort per the request
 * params, so a page that ignores its URL state gets the wrong rows back.
 */
function installFetchStub(
  initialTickets: TicketListItem[],
  deleteFailures?: DeleteFailureController,
  options: FetchStubOptions = {},
): FetchLogEntry[] {
  // Own copy: DELETE mutates the served fixture, and the module-level ticket
  // arrays are shared across tests.
  const tickets = [...initialTickets];
  const log: FetchLogEntry[] = [];
  let totalsFailuresLeft = options.failTotalsOnce ? 1 : 0;
  let filteredFailuresLeft = options.failFilteredOnce ? 1 : 0;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = init?.method?.toUpperCase() ?? "GET";
      log.push({ url, method });
      const parsed = new URL(url, "http://localhost");

      const globalList = parsed.pathname === "/api/tickets";
      const projectList = parsed.pathname.match(
        /^\/api\/projects\/([^/]+)\/tickets$/,
      );
      if (method === "GET" && (globalList || projectList)) {
        const isTotalsRequest =
          globalList &&
          parsed.searchParams.get("sort") === "updated" &&
          parsed.searchParams.get("project") === null &&
          parsed.searchParams.get("status") === null &&
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
          status: (parsed.searchParams.get("status") ??
            undefined) as TicketListFilterInput["status"],
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

      const deleteMatch = parsed.pathname.match(
        /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
      );
      if (method === "DELETE" && deleteMatch) {
        if (deleteFailures?.defer) {
          return await new Promise<Response>((resolve) => {
            deleteFailures.pending.push(resolve);
          });
        }
        const projectName = decodeURIComponent(deleteMatch[1]!);
        const number = Number(deleteMatch[2]!);
        const index = tickets.findIndex(
          (row) => row.projectName === projectName && row.number === number,
        );
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

      return Response.json({ error: "not found" }, { status: 404 });
    },
  );
  return log;
}

function renderPage(search = "") {
  window.history.replaceState(null, "", `/tickets${search}`);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TicketsPage />
    </QueryClientProvider>,
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

describe("TicketsPage list view", () => {
  it("renders every ticket sorted by last update, newest first", async () => {
    installFetchStub(TICKETS);
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Virtualize the attachment index",
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
      "Workout graph re-renders on every tick",
    ]);
    // Row anatomy: id, type badge, status label, session pill.
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

  it("collapses rows to title plus reachable actions on narrow screens", async () => {
    installFetchStub(TICKETS);
    renderPage();

    const title = await screen.findByRole("link", {
      name: "Virtualize the attachment index",
    });
    const row = title.closest("[data-ticket-title]") as HTMLElement;
    expect(row.className).toContain(
      "max-768:grid-cols-[3px_minmax(0,1fr)_44px]",
    );
    expect(title.parentElement?.className).toContain("max-768:col-start-2");
    expect(title.className).toContain("max-768:whitespace-normal");
    expect(
      within(row).getByRole("button", {
        name: "Ticket actions for command-center#12",
      }),
    ).toBeInTheDocument();
    expect(
      within(row).getByRole("button", {
        name: "Ticket actions for command-center#12",
      }).parentElement?.className,
    ).toContain("max-768:col-start-3");
    const headerRow = screen.getAllByRole("row")[0]!;
    expect(headerRow.className).toContain("max-768:sr-only");
    expect(headerRow.className).not.toContain("max-768:hidden");
    expect(within(headerRow).getAllByRole("columnheader")).toHaveLength(8);
    expect(
      within(headerRow).getByRole("columnheader", { name: "Actions" }),
    ).toBeInTheDocument();
    const cells = within(row).getAllByRole("cell");
    expect(cells).toHaveLength(8);
    expect(
      cells.every((cell) => !cell.className.includes("max-768:hidden")),
    ).toBe(true);
  });

  it("hides the header statistics before they can overlap mobile actions", async () => {
    installFetchStub(TICKETS);
    renderPage();

    const stats = (await screen.findByText("4 tickets")).closest(
      "[data-ticket-header-stats]",
    );
    expect(stats).toHaveClass("max-768:hidden");
    expect(stats?.querySelector('[class*="pulse-dot"]')).toHaveClass(
      "motion-reduce:[animation:none]",
    );
  });

  it("wraps the page actions below the heading on narrow screens", async () => {
    installFetchStub(TICKETS);
    renderPage();

    const heading = await screen.findByRole("heading", { name: /tickets/ });
    const header = heading.parentElement?.parentElement;
    const actions = screen
      .getByRole("button", { name: "New ticket" })
      .closest("[data-ticket-page-actions]");

    expect(header).toHaveClass("max-768:flex-wrap");
    expect(actions).toHaveClass("max-768:w-full", "max-768:justify-between");
  });

  it("sorts by creation time when the URL says sort=created", async () => {
    installFetchStub(TICKETS);
    renderPage("?sort=created");

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Interval builder: draggable segment handles",
      "SSE reconnect drops ticket deltas",
      "Virtualize the attachment index",
      "Workout graph re-renders on every tick",
    ]);
  });

  it("filters by status from the URL and reports n of m shown", async () => {
    installFetchStub(TICKETS);
    renderPage("?status=not_started");

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "SSE reconnect drops ticket deltas",
      "Interval builder: draggable segment handles",
    ]);
    expect(screen.getByText("2 of 4 shown")).toBeInTheDocument();
  });

  it("pre-filters to the project named in the URL", async () => {
    installFetchStub(TICKETS);
    renderPage("?project=aerotrainer");

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    expect(rowTitles()).toEqual([
      "Interval builder: draggable segment handles",
      "Workout graph re-renders on every tick",
    ]);
    expect(screen.queryByText("command-center#12")).not.toBeInTheDocument();
    expect(screen.getByText("2 of 4 shown")).toBeInTheDocument();
    // The project select reflects the pre-filter.
    expect(screen.getByRole("combobox", { name: "Project" })).toHaveTextContent(
      "aerotrainer",
    );
  });

  it("navigates to the filtered URL when a filter select changes", async () => {
    installFetchStub(TICKETS);
    renderPage();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Done" }));

    expect(routerReplace).toHaveBeenCalledWith("/tickets?status=done", {
      scroll: false,
    });
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
      }),
    ]);
    renderPage();
    const user = userEvent.setup();

    await screen.findByText("all#1");
    await user.click(screen.getByRole("combobox", { name: "Project" }));
    await user.click(await screen.findByRole("option", { name: /^all$/ }));

    expect(routerReplace).toHaveBeenCalledWith("/tickets?project=all", {
      scroll: false,
    });
  });

  it("shows Clear filters only while filters are active and resets to /tickets", async () => {
    installFetchStub(TICKETS);
    renderPage("?status=done&type=performance");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#3")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(routerReplace).toHaveBeenCalledWith("/tickets", { scroll: false });
  });

  it("omits Clear filters when no filter is active", async () => {
    installFetchStub(TICKETS);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("button", { name: "Clear filters" }),
    ).not.toBeInTheDocument();
  });

  it("shows the no-results empty state when filters exclude everything", async () => {
    installFetchStub(TICKETS);
    renderPage("?status=blocked");

    await waitFor(() =>
      expect(
        screen.getByText("No tickets match these filters"),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText("0 of 4 shown")).toBeInTheDocument();
  });

  it("keeps filtered rows visible and restores totals after a retry", async () => {
    installFetchStub(TICKETS, undefined, { failTotalsOnce: true });
    renderPage("?status=not_started");
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

  it("uses filtered no-results wording while totals are unavailable", async () => {
    installFetchStub(TICKETS, undefined, { failTotalsOnce: true });
    renderPage("?status=blocked");

    await waitFor(() =>
      expect(
        screen.getByText("No tickets match these filters"),
      ).toBeInTheDocument(),
    );
    expect(screen.queryByText("No tickets yet")).not.toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent("ticket totals");
  });

  it("retries the primary ticket list after a load failure", async () => {
    installFetchStub(TICKETS, undefined, { failFilteredOnce: true });
    renderPage("?status=not_started");
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
    renderPage();

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

describe("TicketsPage view switch", () => {
  it("renders the Kanban board for view=board", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=board");

    await waitFor(() =>
      expect(
        screen.getByRole("group", { name: "Not Started column" }),
      ).toBeInTheDocument(),
    );
    // Board cards, not list rows.
    expect(rowTitles()).toEqual([]);
    expect(screen.getByText("command-center#12")).toBeInTheDocument();
  });

  it("opens the mobile board pager on the status selected by the URL filter", async () => {
    installFetchStub(TICKETS);
    renderPage("?view=board&status=in_progress");

    await screen.findByText("command-center#12");
    expect(
      screen.getByRole("button", { name: /^In Progress/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /^Not Started/ }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("pushes the board URL when the segmented control switches views", async () => {
    installFetchStub(TICKETS);
    renderPage("?project=aerotrainer");
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    await user.click(screen.getByRole("radio", { name: "Board" }));
    expect(routerPush).toHaveBeenCalledWith(
      "/tickets?view=board&project=aerotrainer",
      { scroll: false },
    );
  });
});

describe("TicketsPage row actions", () => {
  it("copies the canonical ticket reference from the kebab", async () => {
    installFetchStub(TICKETS);
    renderPage();
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
    renderPage();
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
    renderPage();
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
