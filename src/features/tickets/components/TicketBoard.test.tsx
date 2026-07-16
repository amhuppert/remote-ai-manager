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
import TicketsPage from "../TicketsPage";

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
    status: "in_progress",
    activeSessionName: "csm/ticket-attachments",
  }),
  ticket({
    id: "id-cc-9",
    number: 9,
    title: "SSE reconnect drops ticket deltas",
    workType: "bug",
    status: "not_started",
    attachmentCount: 2,
    updatedAt: "2026-07-10T08:00:00.000Z",
  }),
  ticket({
    id: "id-at-5",
    projectPath: "/repos/aerotrainer",
    projectName: "aerotrainer",
    number: 5,
    title: "Interval builder: draggable segment handles",
    status: "not_started",
    attachmentCount: 0,
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
    description: "",
    workType: item.workType,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    attachments: [],
    sessions: [],
  };
}

interface PatchController {
  /** Deferred PATCH resolvers, in arrival order. */
  pending: Array<() => void>;
  /** When set, PATCH responds with this HTTP status immediately. */
  failWith: number | null;
  /** Controlled failure responses for overlapping mutations. */
  pendingFailures: Array<(response: Response) => void>;
  deferFailures: boolean;
}

interface DeleteController {
  pendingFailures: Array<(response: Response) => void>;
  deferFailures: boolean;
}

interface FetchLogEntry {
  url: string;
  method: string;
  body: unknown;
}

/**
 * Serves the list endpoints from an in-memory fixture through the real shared
 * filter/sort module, and PATCH with either a deferred success (echoing the
 * updated detail) or a forced failure.
 */
function installFetchStub(initialTickets: TicketListItem[]): {
  log: FetchLogEntry[];
  patches: PatchController;
  deletes: DeleteController;
} {
  const tickets = [...initialTickets];
  const log: FetchLogEntry[] = [];
  const patches: PatchController = {
    pending: [],
    failWith: null,
    pendingFailures: [],
    deferFailures: false,
  };
  const deletes: DeleteController = {
    pendingFailures: [],
    deferFailures: false,
  };

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

      const patchMatch = parsed.pathname.match(
        /^\/api\/projects\/([^/]+)\/tickets\/(\d+)$/,
      );
      if (method === "PATCH" && patchMatch) {
        if (patches.deferFailures) {
          return await new Promise<Response>((resolve) => {
            patches.pendingFailures.push(resolve);
          });
        }
        if (patches.failWith !== null) {
          return Response.json(
            { error: "update_failed" },
            { status: patches.failWith },
          );
        }
        const projectName = decodeURIComponent(patchMatch[1]!);
        const number = Number(patchMatch[2]!);
        const index = tickets.findIndex(
          (row) => row.projectName === projectName && row.number === number,
        );
        const updated: TicketListItem = {
          ...tickets[index]!,
          ...(body as Partial<TicketListItem>),
          updatedAt: new Date().toISOString(),
        };
        tickets[index] = updated;
        await new Promise<void>((resolve) => {
          patches.pending.push(resolve);
        });
        return Response.json(detailFor(updated));
      }

      if (method === "DELETE" && patchMatch) {
        if (deletes.deferFailures) {
          return await new Promise<Response>((resolve) => {
            deletes.pendingFailures.push(resolve);
          });
        }
        const projectName = decodeURIComponent(patchMatch[1]!);
        const number = Number(patchMatch[2]!);
        const index = tickets.findIndex(
          (row) => row.projectName === projectName && row.number === number,
        );
        const deleted = tickets[index];
        if (index !== -1) tickets.splice(index, 1);
        return Response.json({
          id: deleted?.id ?? "deleted",
          projectPath: deleted?.projectPath ?? "/repos/unknown",
          projectName,
          number,
        });
      }

      return Response.json({ error: "not found" }, { status: 404 });
    },
  );
  return { log, patches, deletes };
}

function renderBoard() {
  window.history.replaceState(null, "", "/tickets?view=board");
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TicketsPage />
    </QueryClientProvider>,
  );
}

function column(name: string): HTMLElement {
  return screen.getByRole("group", { name: `${name} column` });
}

/**
 * jsdom has no layout, so column/card geometry is synthesized: five columns
 * at x = 0..800 in status order, cards inside their column.
 */
function installBoardGeometry(): { mockRestore: () => void } {
  const COLUMN_X: Record<string, number> = {
    "Not Started column": 0,
    "In Progress column": 200,
    "Done column": 400,
    "Blocked column": 600,
    "Closed column": 800,
  };
  const makeRect = (
    left: number,
    top: number,
    width: number,
    height: number,
  ): DOMRect =>
    ({
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
  return vi
    .spyOn(Element.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      const columnEl = el.closest("[role='group']");
      const x = COLUMN_X[columnEl?.getAttribute("aria-label") ?? ""] ?? 0;
      if (el === columnEl) return makeRect(x, 0, 190, 600);
      if (el.hasAttribute("data-ticket-card"))
        return makeRect(x + 5, 40, 180, 80);
      return makeRect(0, 0, 0, 0);
    });
}

beforeEach(() => {
  routerReplace.mockClear();
  routerPush.mockClear();
  useToastStoreForTesting.setState({ toasts: [] });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TicketBoard columns", () => {
  it("replaces the Board placeholder with five status columns and groups cards", async () => {
    installFetchStub(TICKETS);
    renderBoard();

    await waitFor(() =>
      expect(screen.getByText("command-center#12")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Board view")).not.toBeInTheDocument();

    const notStarted = column("Not Started");
    expect(
      within(notStarted).getByText("command-center#9"),
    ).toBeInTheDocument();
    expect(within(notStarted).getByText("aerotrainer#5")).toBeInTheDocument();
    expect(within(notStarted).getByLabelText("2 tickets")).toBeInTheDocument();

    expect(
      within(column("In Progress")).getByText("command-center#12"),
    ).toBeInTheDocument();
    expect(
      within(column("Done")).getByText("aerotrainer#3"),
    ).toBeInTheDocument();

    // Empty columns invite a drop instead of collapsing.
    expect(
      within(column("Blocked")).getByText(/No tickets/),
    ).toBeInTheDocument();
    expect(
      within(column("Closed")).getByText(/No tickets/),
    ).toBeInTheDocument();

    // Card anatomy: type badge, attachment count, active-session dot.
    const card = within(column("In Progress"))
      .getByText("command-center#12")
      .closest("[data-ticket-card]") as HTMLElement;
    expect(within(card).getByText("feature")).toBeInTheDocument();
    expect(within(card).getByText("5")).toBeInTheDocument();
    expect(
      within(card).getByText("csm/ticket-attachments"),
    ).toBeInTheDocument();
  });

  it("keeps cards draggable-accessible with screen-reader instructions", async () => {
    installFetchStub(TICKETS);
    renderBoard();
    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );

    const card = screen
      .getByText("command-center#9")
      .closest("[data-ticket-card]") as HTMLElement;
    // The card root must NOT be interactive: role=button with focusable
    // children (links, kebab) is invalid ARIA (axe nested-interactive).
    // Keyboard dragging lives on a dedicated activator handle instead.
    expect(card).not.toHaveAttribute("role");
    expect(card).not.toHaveAttribute("tabindex");
    const handle = screen.getByRole("button", {
      name: "Drag command-center#9",
    });
    expect(handle).toHaveAttribute("aria-roledescription");
    // dnd-kit renders hidden screen-reader instructions covering the protocol.
    expect(document.body.textContent).toMatch(/space/i);
    expect(document.body.textContent).toMatch(/left and right arrow keys/i);
    expect(document.body.textContent).not.toMatch(/up and down arrow keys/i);
  });

  it("exposes the selected mobile status page as a pressed button", async () => {
    installFetchStub(TICKETS);
    renderBoard();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const notStarted = screen.getByRole("button", { name: /Not Started/ });
    const inProgress = screen.getByRole("button", { name: /In Progress/ });

    expect(notStarted).toHaveAttribute("aria-pressed", "true");
    expect(inProgress).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(inProgress);

    expect(notStarted).toHaveAttribute("aria-pressed", "false");
    expect(inProgress).toHaveAttribute("aria-pressed", "true");
  });
});

describe("TicketBoard status moves", () => {
  it("switches the mobile pager to the selected status and restores focus to the moved card", async () => {
    const { patches } = installFetchStub(TICKETS);
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Move command-center#9 to" }),
    );
    await user.click(await screen.findByRole("option", { name: "Done" }));

    expect(screen.getByRole("button", { name: /^Done/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Drag command-center#9" }),
      ),
    );
    patches.pending.forEach((resolve) => resolve());
  });

  it("returns the mobile pager and focus to the source status when a move fails", async () => {
    const { patches } = installFetchStub(TICKETS);
    patches.failWith = 500;
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Move command-center#9 to" }),
    );
    await user.click(await screen.findByRole("option", { name: "Done" }));

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /^Not Started/ }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Drag command-center#9" }),
      ),
    );
  });

  it("moves a card optimistically via the kebab Move-to radio group", async () => {
    const { log, patches } = installFetchStub(TICKETS);
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ticket actions for command-center#9",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Done" }),
    );

    // Optimistic: the card is in Done while the PATCH is still unresolved.
    expect(
      within(column("Done")).getByText("command-center#9"),
    ).toBeInTheDocument();
    expect(
      log.some(
        (entry) =>
          entry.method === "PATCH" &&
          entry.url.includes("/api/projects/command-center/tickets/9") &&
          (entry.body as { status?: string }).status === "done",
      ),
    ).toBe(true);

    patches.pending.forEach((resolve) => resolve());
    await waitFor(() =>
      expect(
        within(column("Done")).getByText("command-center#9"),
      ).toBeInTheDocument(),
    );
  });

  it("rolls back the move and toasts when the server rejects it", async () => {
    const { patches } = installFetchStub(TICKETS);
    patches.failWith = 500;
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ticket actions for command-center#9",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Done" }),
    );

    // Rolled back to the source column…
    await waitFor(() =>
      expect(
        within(column("Not Started")).getByText("command-center#9"),
      ).toBeInTheDocument(),
    );
    // …with a toast naming the ticket and the failed target.
    await waitFor(() => {
      const messages = useToastStoreForTesting
        .getState()
        .toasts.map((t) => t.message);
      expect(
        messages.some(
          (m) => m.includes("command-center#9") && m.includes("Done"),
        ),
      ).toBe(true);
    });
  });

  it("reports each failed move when rapid mutations overlap", async () => {
    const { patches } = installFetchStub(TICKETS);
    patches.deferFailures = true;
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const move = async (identifier: string, target: string) => {
      await user.click(
        screen.getByRole("button", {
          name: `Ticket actions for ${identifier}`,
        }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: target }),
      );
    };

    await move("command-center#9", "Done");
    await waitFor(() => expect(patches.pendingFailures).toHaveLength(1));
    await move("aerotrainer#5", "In Progress");
    await waitFor(() => expect(patches.pendingFailures).toHaveLength(2));

    await act(async () => {
      patches.pendingFailures[0]!(
        Response.json({ error: "update_failed" }, { status: 500 }),
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
    });

    await act(async () => {
      patches.pendingFailures[1]!(
        Response.json({ error: "update_failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await waitFor(() => {
      const messages = useToastStoreForTesting
        .getState()
        .toasts.map((toast) => toast.message);
      expect(
        messages.some((message) => message.includes("aerotrainer#5")),
      ).toBe(true);
    });
  });

  it("reports each failed delete when rapid board actions overlap", async () => {
    const { deletes } = installFetchStub(TICKETS);
    deletes.deferFailures = true;
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const remove = async (identifier: string) => {
      await user.click(
        screen.getByRole("button", {
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
    await waitFor(() => expect(deletes.pendingFailures).toHaveLength(1));
    await remove("aerotrainer#5");
    await waitFor(() => expect(deletes.pendingFailures).toHaveLength(2));

    await act(async () => {
      deletes.pendingFailures[0]!(
        Response.json({ error: "delete_failed" }, { status: 500 }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      deletes.pendingFailures[1]!(
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

  it("moves focus to the next card after a confirmed deletion", async () => {
    installFetchStub(TICKETS);
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ticket actions for command-center#9",
      }),
    );
    await user.click(
      await screen.findByRole("menuitem", { name: "Delete ticket…" }),
    );
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText("command-center#9")).not.toBeInTheDocument(),
    );
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Drag aerotrainer#5" }),
    );
  });

  it("does not start a keyboard drag from the card's inner links (Enter must navigate)", async () => {
    installFetchStub(TICKETS);
    renderBoard();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const titleLink = screen.getByRole("link", {
      name: "SSE reconnect drops ticket deltas",
    });
    titleLink.focus();
    fireEvent.keyDown(titleLink, { key: "Enter", code: "Enter" });

    // No pickup: no aria-live drag announcement, no overlay twin of the card.
    expect(screen.queryByText(/is over/)).not.toBeInTheDocument();
    expect(
      document.querySelectorAll("[data-ticket-card='command-center#9']"),
    ).toHaveLength(1);
  });

  it("starts a keyboard drag from the drag handle and cancels on Escape", async () => {
    installFetchStub(TICKETS);
    renderBoard();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    const card = screen.getByRole("button", {
      name: "Drag command-center#9",
    });
    card.focus();
    fireEvent.keyDown(card, { key: "Enter", code: "Enter" });

    // Pickup: the DragOverlay renders the lifted twin and the aria-live
    // region announces the target status (the single live region always
    // holds the latest message, so "Picked up" is immediately replaced).
    await waitFor(() =>
      expect(
        document.querySelectorAll("[data-ticket-card='command-center#9']")
          .length,
      ).toBeGreaterThan(1),
    );
    expect(screen.getByText(/command-center#9 is over/)).toBeInTheDocument();

    // dnd-kit schedules post-cancel focus work from an effect. Model a later
    // same-frame blur so restoration must run after that library cleanup.
    queueMicrotask(() => {
      requestAnimationFrame(() => card.blur());
    });
    fireEvent.keyDown(card, { key: "Escape", code: "Escape" });
    await waitFor(() =>
      expect(screen.getByText(/Movement cancelled/)).toBeInTheDocument(),
    );
    // The twin is gone and the card stays in its source column.
    expect(
      document.querySelectorAll("[data-ticket-card='command-center#9']"),
    ).toHaveLength(1);
    expect(
      within(column("Not Started")).getByText("command-center#9"),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Drag command-center#9" }),
      ),
    );
  });

  it("commits an optimistic move when a keyboard drag drops on another column", async () => {
    const rectSpy = installBoardGeometry();

    try {
      const { log, patches } = installFetchStub(TICKETS);
      renderBoard();

      await waitFor(() =>
        expect(screen.getByText("command-center#9")).toBeInTheDocument(),
      );
      const card = screen.getByRole("button", {
        name: "Drag command-center#9",
      });
      card.focus();
      fireEvent.keyDown(card, { key: "Enter", code: "Enter" });
      await waitFor(() =>
        expect(
          document.querySelectorAll("[data-ticket-card='command-center#9']")
            .length,
        ).toBeGreaterThan(1),
      );

      fireEvent.keyDown(card, { key: "ArrowRight", code: "ArrowRight" });
      await waitFor(() =>
        expect(
          screen.getByText(/command-center#9 is over In Progress/),
        ).toBeInTheDocument(),
      );
      fireEvent.keyDown(card, { key: "Enter", code: "Enter" });

      // Optimistic: the card lands in In Progress and the PATCH went out.
      await waitFor(() =>
        expect(
          within(column("In Progress")).getByText("command-center#9"),
        ).toBeInTheDocument(),
      );
      expect(
        log.some(
          (entry) =>
            entry.method === "PATCH" &&
            entry.url.includes("/api/projects/command-center/tickets/9") &&
            (entry.body as { status?: string }).status === "in_progress",
        ),
      ).toBe(true);
      // Keyboard operability must survive the move: the card remounts in the
      // target column (destroying the old activator node), so the board
      // restores focus to the moved card's drag handle.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Drag command-center#9" }),
        ),
      );
      patches.pending.forEach((resolve) => resolve());
    } finally {
      rectSpy.mockRestore();
    }
  });

  it("offers Retry on the failure toast, and Retry re-issues the move", async () => {
    const { log, patches } = installFetchStub(TICKETS);
    patches.failWith = 500;
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("command-center#9")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Ticket actions for command-center#9",
      }),
    );
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Done" }),
    );

    await waitFor(() =>
      expect(
        within(column("Not Started")).getByText("command-center#9"),
      ).toBeInTheDocument(),
    );
    const toast = await waitFor(() => {
      const found = useToastStoreForTesting
        .getState()
        .toasts.find((t) => t.action?.label === "Retry");
      expect(found).toBeDefined();
      return found!;
    });

    patches.failWith = null;
    const patchesBefore = log.filter((e) => e.method === "PATCH").length;
    act(() => toast.action!.onClick());

    await waitFor(() =>
      expect(
        within(column("Done")).getByText("command-center#9"),
      ).toBeInTheDocument(),
    );
    expect(log.filter((e) => e.method === "PATCH").length).toBe(
      patchesBefore + 1,
    );
    patches.pending.forEach((resolve) => resolve());
  });

  it("commits the same mutation from the always-visible mobile Move-to select", async () => {
    const { log, patches } = installFetchStub(TICKETS);
    renderBoard();
    const user = userEvent.setup();

    await waitFor(() =>
      expect(screen.getByText("aerotrainer#5")).toBeInTheDocument(),
    );
    await user.click(
      screen.getByRole("combobox", { name: "Move aerotrainer#5 to" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "In Progress" }),
    );

    expect(
      log.some(
        (entry) =>
          entry.method === "PATCH" &&
          entry.url.includes("/api/projects/aerotrainer/tickets/5") &&
          (entry.body as { status?: string }).status === "in_progress",
      ),
    ).toBe(true);
    expect(
      within(column("In Progress")).getByText("aerotrainer#5"),
    ).toBeInTheDocument();
    patches.pending.forEach((resolve) => resolve());
  });
});
