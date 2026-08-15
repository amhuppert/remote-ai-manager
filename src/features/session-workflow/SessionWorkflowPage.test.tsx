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
      workflowDefinitionKeys.detail("proj", item.seedDefinitionId),
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
