// @vitest-environment jsdom
import {
  useSyncExternalStore,
  type AnchorHTMLAttributes,
  type ReactNode,
} from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import {
  createWorkflowDefinition,
  createWorkflowDefinitionRecord,
  createWorkflowExecution,
  makeLaunchDocument,
} from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowExecutionHistoryItem } from "@/lib/workflow-graph/schemas";
import {
  graphWorkflowEventsKeys,
  graphWorkflowExecutionKeys,
  graphWorkflowHistoryKeys,
  graphWorkflowResultKeys,
  workflowDefinitionKeys,
} from "@/lib/workflows/query-keys";
import SessionWorkflowPage from "./SessionWorkflowPage";

const routerReplace = vi.fn();
const routeParams = { name: "proj", session: "sess" };
const pathname = "/projects/proj/sess/workflow";
const urlSubscribers = new Set<() => void>();
let urlVersion = 0;

function navigateInPlace(href: string): void {
  window.history.pushState({}, "", href);
  urlVersion += 1;
  for (const notify of [...urlSubscribers]) notify();
}

function useFakeSearchParams(): URLSearchParams {
  useSyncExternalStore(
    (notify) => {
      urlSubscribers.add(notify);
      return () => {
        urlSubscribers.delete(notify);
      };
    },
    () => urlVersion,
    () => urlVersion,
  );
  return new URLSearchParams(window.location.search);
}

vi.mock("next/navigation", () => ({
  useParams: () => routeParams,
  usePathname: () => pathname,
  useRouter: () => ({
    replace: (href: string, options?: { scroll?: boolean }) => {
      routerReplace(href, options);
      navigateInPlace(href);
    },
  }),
  useSearchParams: () => useFakeSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  } & AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      href={href}
      {...rest}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        navigateInPlace(href);
      }}
    >
      {children}
    </a>
  ),
}));

function execution(
  id: string,
  startedAt: string,
  status: "running" | "completed" = "completed",
) {
  return createWorkflowExecution({
    id,
    status,
    startedAt,
    completedAt: status === "completed" ? "2026-08-14T15:30:00.000Z" : null,
    launchDocument: makeLaunchDocument(createWorkflowDefinition(), {
      name: id,
      description: `${id} description`,
    }),
  });
}

function summary(
  full: ReturnType<typeof execution>,
): GraphWorkflowExecutionHistoryItem {
  return {
    executionId: full.id,
    definitionId: full.seedDefinitionId,
    definitionRevision: full.seedDefinitionRevision,
    status: full.status,
    startedAt: full.startedAt,
    completedAt: full.completedAt,
    haltReason: full.haltReason,
    archived: true,
  };
}

function seedPage(
  current: ReturnType<typeof execution> | null,
  history: Array<ReturnType<typeof execution>>,
) {
  const client = createTestQueryClient();
  client.setDefaultOptions({
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: Number.POSITIVE_INFINITY,
    },
  });
  client.setQueryData(
    graphWorkflowExecutionKeys.detail("proj", "sess"),
    current,
  );
  client.setQueryData(
    graphWorkflowHistoryKeys.list("proj", "sess"),
    history.map(summary),
  );
  for (const item of [...history, ...(current ? [current] : [])]) {
    client.setQueryData(
      graphWorkflowExecutionKeys.byId("proj", "sess", item.id),
      item,
    );
    client.setQueryData(
      graphWorkflowEventsKeys.list("proj", "sess", item.id),
      [],
    );
    client.setQueryData(
      graphWorkflowResultKeys.detail("proj", "sess", item.id, null),
      null,
    );
    client.setQueryData(
      workflowDefinitionKeys.detail("proj", item.seedDefinitionId ?? ""),
      { item: createWorkflowDefinitionRecord() },
    );
  }
  return client;
}

describe("SessionWorkflowPage execution selection", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    routerReplace.mockReset();
    urlSubscribers.clear();
    urlVersion = 0;
    window.history.replaceState({}, "", pathname);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("defaults without URL mutation to Current, or newest History when Current is absent", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const older = execution("exec-old", "2026-08-14T12:00:00.000Z");
    const newest = execution("exec-new", "2026-08-14T14:00:00.000Z");
    const first = renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(current, [older, newest]),
    );

    await waitFor(() =>
      expect(
        first.container.querySelector("[data-workflow-execution-id]"),
      ).toHaveAttribute("data-workflow-execution-id", "exec-current"),
    );
    expect(window.location.search).toBe("");
    expect(routerReplace).not.toHaveBeenCalled();
    first.unmount();

    renderWithQuery(<SessionWorkflowPage />, seedPage(null, [older, newest]));
    await waitFor(() =>
      expect(
        document.querySelector("[data-workflow-execution-id]"),
      ).toHaveAttribute("data-workflow-execution-id", "exec-new"),
    );
    expect(window.location.search).toBe("");
  });

  it("restores a deep link and updates the URL only on user selection", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const historical = execution("exec-history", "2026-08-14T12:00:00.000Z");
    navigateInPlace(`${pathname}?execution=exec-history`);
    const { container } = renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(current, [historical]),
    );

    await waitFor(() =>
      expect(
        container.querySelector("[data-workflow-execution-id]"),
      ).toHaveAttribute("data-workflow-execution-id", "exec-history"),
    );

    await userEvent.click(
      screen.getByRole("button", { name: /execution exec-current/i }),
    );
    expect(routerReplace).toHaveBeenCalledWith(
      `${pathname}?execution=exec-current`,
      { scroll: false },
    );
    await waitFor(() =>
      expect(
        container.querySelector("[data-workflow-execution-id]"),
      ).toHaveAttribute("data-workflow-execution-id", "exec-current"),
    );
  });

  it("links the selected execution to its exact source definition", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const historical = execution("exec-history", "2026-08-14T12:00:00.000Z");
    renderWithQuery(<SessionWorkflowPage />, seedPage(current, [historical]));

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Source definition" }),
      ).toHaveAttribute(
        "href",
        `/projects/proj/workflows?definition=${encodeURIComponent(current.seedDefinitionId ?? "")}`,
      ),
    );
    await userEvent.click(
      screen.getByRole("button", { name: /execution exec-history/i }),
    );
    expect(
      screen.getByRole("link", { name: "Source definition" }),
    ).toHaveAttribute(
      "href",
      `/projects/proj/workflows?definition=${encodeURIComponent(historical.seedDefinitionId ?? "")}`,
    );
  });

  it("keeps explicit History selection across a new launch and rail invalidation", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const historical = execution("exec-history", "2026-08-14T12:00:00.000Z");
    navigateInPlace(`${pathname}?execution=exec-history`);
    const client = seedPage(current, [historical]);
    const { container } = renderWithQuery(<SessionWorkflowPage />, client);

    await waitFor(() =>
      expect(
        container.querySelector("[data-workflow-execution-id]"),
      ).toHaveAttribute("data-workflow-execution-id", "exec-history"),
    );

    const replacement = execution(
      "exec-replacement",
      "2026-08-14T17:00:00.000Z",
      "running",
    );
    await act(async () => {
      client.setQueryData(
        graphWorkflowExecutionKeys.detail("proj", "sess"),
        replacement,
      );
      client.setQueryData(
        graphWorkflowExecutionKeys.byId("proj", "sess", replacement.id),
        replacement,
      );
      client.setQueryData(graphWorkflowHistoryKeys.list("proj", "sess"), [
        summary(current),
        summary(historical),
      ]);
    });

    expect(window.location.search).toBe("?execution=exec-history");
    expect(
      container.querySelector("[data-workflow-execution-id]"),
    ).toHaveAttribute("data-workflow-execution-id", "exec-history");
    expect(routerReplace).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /execution exec-history/i }),
    ).toHaveAttribute("aria-current", "true");
  });
});

describe("SessionWorkflowPage rail collapse", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    routerReplace.mockReset();
    urlSubscribers.clear();
    urlVersion = 0;
    window.history.replaceState({}, "", pathname);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("collapses the executions rail to a labelled strip and restores it", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    renderWithQuery(<SessionWorkflowPage />, seedPage(current, []));

    await waitFor(() =>
      expect(
        screen.getByRole("navigation", { name: "Workflow executions" }),
      ).toBeInTheDocument(),
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Collapse executions rail" }),
    );
    expect(
      screen.queryByRole("navigation", { name: "Workflow executions" }),
    ).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Expand executions rail" }),
    );
    expect(
      screen.getByRole("navigation", { name: "Workflow executions" }),
    ).toBeInTheDocument();
  });
});

// M2 / criterion 4: below 768px the executions rail is not a rail — it is a
// sheet the status bar's run chip opens, and choosing a run out of it is one
// act: dismiss, back to Graph, and write the choice to the URL.
describe("SessionWorkflowPage mobile executions sheet", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: /\(max-width:/.test(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    routerReplace.mockReset();
    urlSubscribers.clear();
    urlVersion = 0;
    window.history.replaceState({}, "", pathname);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("moves the executions rail into a sheet behind the run chip", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(current, [
        execution("exec-history", "2026-08-14T12:00:00.000Z"),
      ]),
    );

    // The rail never stands up as a panel at this width — the tab bar owns
    // what is on screen, and a fourth panel it cannot reach would be stranded.
    await waitFor(() =>
      expect(screen.getByTestId("execution-chip")).toBeInTheDocument(),
    );
    expect(
      screen.queryByRole("navigation", { name: "Workflow executions" }),
    ).toBeNull();

    await userEvent.click(screen.getByTestId("execution-chip"));
    expect(
      screen.getByRole("navigation", { name: "Workflow executions" }),
    ).toBeInTheDocument();
  });

  it("names the selected run and its tenure on the chip", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    renderWithQuery(<SessionWorkflowPage />, seedPage(current, []));

    await waitFor(() =>
      expect(screen.getByTestId("execution-chip")).toHaveTextContent(
        "exec-cur · Current",
      ),
    );
  });

  it("closes the sheet, returns to Graph and writes the URL on a selection", async () => {
    const current = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const historical = execution("exec-history", "2026-08-14T12:00:00.000Z");
    const { container } = renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(current, [historical]),
    );

    await waitFor(() =>
      expect(screen.getByTestId("execution-chip")).toBeInTheDocument(),
    );

    // Get off Graph first, so the return is the switch under test.
    await userEvent.click(screen.getByRole("button", { name: "Inspector" }));
    expect(container.firstElementChild).toHaveAttribute(
      "data-mobile-panel",
      "inspector",
    );

    await userEvent.click(screen.getByTestId("execution-chip"));
    await userEvent.click(
      screen.getByRole("button", { name: /execution exec-history/i }),
    );

    expect(
      screen.queryByRole("navigation", { name: "Workflow executions" }),
    ).toBeNull();
    expect(container.firstElementChild).toHaveAttribute(
      "data-mobile-panel",
      "graph",
    );
    expect(routerReplace).toHaveBeenCalledWith(
      `${pathname}?execution=exec-history`,
      { scroll: false },
    );
  });

  // README §12 — the target minimum covers every state of the page, and a
  // session with no workflow is the first one a reader sees. Its only action
  // sits at 0.78rem/10px padding, which is short of 44px on its own.
  it("gives the empty state's only action a 44px touch target", async () => {
    renderWithQuery(<SessionWorkflowPage />, seedPage(null, []));

    await waitFor(() =>
      expect(screen.getByText("No workflow configured")).toBeInTheDocument(),
    );
    expect(screen.getByRole("link", { name: "Browse templates" })).toHaveClass(
      "max-768:min-h-[44px]",
    );
  });
});

// M2 / criterion 3: the execution page's panel-switching rules. Default Graph;
// selecting a context switches to Inspector; opening a transcript switches to
// Log and closing it returns to Graph. Panel visibility is CSS, so the contract
// is asserted on `data-mobile-panel` and the tab bar's current tab.
describe("SessionWorkflowPage mobile panel switching", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((query: string) => ({
        matches: /\(max-width:/.test(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [] })),
    );
    routerReplace.mockReset();
    urlSubscribers.clear();
    urlVersion = 0;
    window.history.replaceState({}, "", pathname);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A run with one task that has a transcript to open. */
  function runWithTranscript() {
    const run = execution(
      "exec-current",
      "2026-08-14T16:00:00.000Z",
      "running",
    );
    const task = run.taskStates["task-plan-1"];
    if (task) {
      task.status = "completed";
      task.lastConversationId = "conv-plan-1";
    }
    return run;
  }

  function panelOf(container: HTMLElement): string | null {
    return (
      container.firstElementChild?.getAttribute("data-mobile-panel") ?? null
    );
  }

  function currentTab(): string | null {
    return (
      document.querySelector('[aria-current="page"]')?.textContent?.trim() ??
      null
    );
  }

  it("opens on Graph and switches to Inspector when a context is selected", async () => {
    const { container } = renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(runWithTranscript(), []),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="mobile-lane-member"]'),
      ).not.toBeNull(),
    );
    expect(panelOf(container)).toBe("graph");
    expect(currentTab()).toBe("Graph");

    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[data-testid="mobile-lane-member"][data-context-id="context-plan"]',
      ) as HTMLElement,
    );

    expect(panelOf(container)).toBe("inspector");
    expect(currentTab()).toBe("Inspector");
  });

  it("switches to Log when a transcript opens and back to Graph when it closes", async () => {
    const { container } = renderWithQuery(
      <SessionWorkflowPage />,
      seedPage(runWithTranscript(), []),
    );

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="mobile-lane-member"]'),
      ).not.toBeNull(),
    );
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[data-testid="mobile-lane-member"][data-context-id="context-plan"]',
      ) as HTMLElement,
    );

    await userEvent.click(await screen.findByRole("button", { name: "View" }));
    expect(panelOf(container)).toBe("log");
    expect(currentTab()).toBe("Log");

    await userEvent.click(
      await screen.findByRole("button", { name: /close transcript/i }),
    );
    expect(panelOf(container)).toBe("graph");
    expect(currentTab()).toBe("Graph");
  });
});
