// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, cleanup, act } from "@testing-library/react";
import PanesGrid from "./PanesGrid";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";

function makeConversation(
  id: string,
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    scope: "session",
    id,
    name: `Conversation ${id}`,
    status: "running",
    lastActivityAt: new Date().toISOString(),
    projectName: "proj",
    projectPath: "/tmp/proj",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/tmp/proj/.worktrees/x",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    backgroundActivity: null,
    sessionName: "sess",
    branchName: "csm/x",
    ...overrides,
  };
}

function renderGrid(props: {
  workingSet: SessionActiveConversation[];
  activeId: string;
  isAtCap?: boolean;
  addableConversations?: SessionActiveConversation[];
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const onActivate = vi.fn();
  const onOpenFull = vi.fn();
  const onClose = vi.fn();
  const onAdd = vi.fn();
  const onExit = vi.fn();
  const result = render(
    <QueryClientProvider client={client}>
      <PanesGrid
        workingSet={props.workingSet}
        activeId={props.activeId}
        isAtCap={props.isAtCap ?? false}
        addableConversations={props.addableConversations ?? []}
        onActivate={onActivate}
        onOpenConversation={vi.fn()}
        onOpenFull={onOpenFull}
        onClose={onClose}
        onAdd={onAdd}
        onExit={onExit}
      />
    </QueryClientProvider>,
  );
  return { ...result, onActivate, onOpenFull, onClose, onAdd, onExit };
}

function panesRoot(container: HTMLElement): HTMLElement {
  const el = container.firstElementChild;
  if (!(el instanceof HTMLElement)) throw new Error("no panes root");
  return el;
}

function panesGrid(container: HTMLElement): HTMLElement {
  // The grid is the element carrying the computed shape + --cols/--rows.
  const el = container.querySelector("[data-shape]");
  if (!(el instanceof HTMLElement))
    throw new Error("no panes grid (data-shape)");
  return el;
}

beforeEach(() => {
  useSessionDetailStore.getState().resetStore();
});

afterEach(cleanup);

describe("PanesGrid", () => {
  it("renders one pane per conversation and a toolbar with the count (3.2)", () => {
    const workingSet = [
      makeConversation("a"),
      makeConversation("b"),
      makeConversation("c"),
    ];
    renderGrid({ workingSet, activeId: "a" });

    const closeButtons = screen.getAllByLabelText("Close pane");
    expect(closeButtons).toHaveLength(3);

    expect(screen.getByText("3 / 6 panes")).toBeInTheDocument();
  });

  it("marks the active conversation's pane with data-active and leaves the others unmarked", () => {
    const workingSet = [
      makeConversation("a"),
      makeConversation("b"),
      makeConversation("c"),
    ];
    const { container } = renderGrid({ workingSet, activeId: "b" });

    const panes = container.querySelectorAll<HTMLElement>("section");
    expect(panes).toHaveLength(3);

    const active = Array.from(panes).filter(
      (p) => p.getAttribute("data-active") === "true",
    );
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toContain("Conversation b");
  });

  it.each([
    { count: 2, shape: "row", cols: "2", rows: "1" },
    { count: 4, shape: "grid-2x2", cols: "2", rows: "2" },
    { count: 5, shape: "asym-5", cols: "6", rows: "2" },
    { count: 6, shape: "grid-3x2", cols: "3", rows: "2" },
  ])(
    "reflows the grid for $count panes → data-shape=$shape cols=$cols rows=$rows (3.2/3.4)",
    ({ count, shape, cols, rows }) => {
      const workingSet = Array.from({ length: count }, (_, i) =>
        makeConversation(`c${i}`),
      );
      const { container } = renderGrid({ workingSet, activeId: "c0" });

      const grid = panesGrid(container);
      expect(grid.getAttribute("data-shape")).toBe(shape);
      expect(grid.style.getPropertyValue("--cols")).toBe(cols);
      expect(grid.style.getPropertyValue("--rows")).toBe(rows);
    },
  );

  it("reflects composer focus via data-composer-focused and reverts on blur (5.3/5.4)", () => {
    const workingSet = [makeConversation("a"), makeConversation("b")];
    const { container } = renderGrid({ workingSet, activeId: "a" });

    const panes = panesRoot(container);
    expect(panes.getAttribute("data-composer-focused")).toBeNull();

    act(() => {
      useSessionDetailStore.getState().setComposerFocused(true);
    });
    expect(panes.getAttribute("data-composer-focused")).toBe("true");

    act(() => {
      useSessionDetailStore.getState().setComposerFocused(false);
    });
    expect(panes.getAttribute("data-composer-focused")).toBeNull();
  });
});
