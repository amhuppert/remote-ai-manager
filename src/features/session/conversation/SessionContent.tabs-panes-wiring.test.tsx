// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactElement } from "react";
import SessionContent from "@/features/session/conversation/SessionContent";
import { useSessionDetailStore } from "@/stores/session-detail.store";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";

// Stub only the genuinely-heavy non-strip children that need full app context
// and are NOT under test here. The tab strip, add menu, and panes grid render
// for real so the click → operation wiring is exercised end-to-end (the
// existing SessionContent.test.tsx stubs the strip/grid and so only proves
// presence, not wiring).
vi.mock("@/features/session/conversation/SessionInfoStrip", () => ({
  default: () => <div data-testid="stub-info-strip" />,
}));
vi.mock("@/features/session/conversation/RightPane", () => ({
  default: () => <div data-testid="stub-right-pane" />,
}));
vi.mock("@/features/session/conversation/ConversationPanelContainer", () => ({
  default: () => <div data-testid="stub-conversation-panel" />,
}));
vi.mock("@/features/session/mobile/MobileInfoPanel", () => ({
  default: () => <div data-testid="stub-mobile-info-panel" />,
}));

function renderWithQuery(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    sessionName: "sess-1",
    worktreePath: "/proj/.worktrees/sess-1",
    branchName: "csm/sess-1",
    createdAt: "2024-06-15T10:00:00Z",
    lastActivityAt: "2024-06-15T12:00:00Z",
    archived: false,
    finished: false,
    conversations: [],
    source: "cc",
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    referenceDocuments: [],
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
    scope: "session",
    name: null,
    transcriptPath: null,
    status: "new",
    promptCount: 0,
    createdAt: "2024-06-15T10:00:00Z",
    lastActivityAt: "2024-06-15T10:00:00Z",
    source: "cc",
    summary: null,
    archived: false,
    totalCostUsd: null,
    totalDurationMs: null,
    totalTurns: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    pendingPromptText: null,
    forkedFrom: null,
    role: null,
    activeTurnSource: null,
    contextTokens: null,
    contextWindowMax: null,
    debugMode: null,
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
}

function makeActiveConversation(
  overrides: Partial<SessionActiveConversation> = {},
): SessionActiveConversation {
  return {
    id: "conv-1",
    scope: "session",
    name: "Conversation one",
    status: "new",
    lastActivityAt: "2024-06-15T12:00:00Z",
    projectName: "my-proj",
    projectPath: "/proj",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/proj/.worktrees/sess-1",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: "sess-1",
    branchName: "csm/sess-1",
    ...overrides,
  };
}

// A 2-tab working set plus one addable conversation not in the set.
const TAB_A = makeActiveConversation({ id: "conv-a", name: "Alpha" });
const TAB_B = makeActiveConversation({ id: "conv-b", name: "Beta" });
const ADDABLE_C = makeActiveConversation({ id: "conv-c", name: "Gamma" });

function makeOpenTabs(overrides: Partial<OpenTabsApi> = {}): OpenTabsApi {
  return {
    workingSet: [TAB_A, TAB_B],
    addableConversations: [ADDABLE_C],
    activeId: "conv-a",
    isAtCap: false,
    persistedLruLive: [],
    hydrated: true,
    activate: vi.fn(),
    closeTab: vi.fn(),
    addTab: vi.fn(),
    ...overrides,
  };
}

type Props = ComponentProps<typeof SessionContent>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    session: makeSession(),
    activeConversation: makeConversation(),
    projectName: "my-proj",
    sessionName: "sess-1",
    conversationId: "conv-a",
    statusDotClass: "status-dot-idle",
    displayStatus: "idle",
    contextPercent: null,
    buildContext: () => null,
    isFinished: false,
    targetBranch: "main",
    layout: "default",
    mobilePanel: "chat",
    panelContainerProps: {} as Props["panelContainerProps"],
    promptInputSlot: null,
    tddEnabled: false,
    onTddChange: vi.fn(),
    tddDisabled: false,
    onLayoutChange: vi.fn(),
    dsOpen: false,
    dsServers: [],
    dsClose: vi.fn(),
    dsToggle: vi.fn(),
    dsStartServer: vi.fn(),
    dsStopServer: vi.fn(),
    dsStartAll: vi.fn(),
    dsStopAll: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

/** The `role="tab"` element whose title text matches. */
function tabByTitle(title: string): HTMLElement {
  const tab = screen
    .getAllByRole("tab")
    .find((el) => within(el).queryByText(title) !== null);
  if (!tab) throw new Error(`No tab with title "${title}"`);
  return tab;
}

/** The pane <section> whose title text matches. */
function paneByTitle(title: string): HTMLElement {
  const heading = screen.getByText(title);
  const pane = heading.closest("section");
  if (!(pane instanceof HTMLElement))
    throw new Error(`No pane with title "${title}"`);
  return pane;
}

beforeEach(() => {
  // Pane reads composerFocused from the session-detail store; keep it at its
  // default so pane emphasis state never leaks between tests.
  useSessionDetailStore.setState({ composerFocused: false });
});

describe("SessionContent tabs/panes wiring", () => {
  describe("tab strip (non-panes layout)", () => {
    it("clicking an inactive tab's body calls openTabs.activate with that id, not closeTab (2.4)", () => {
      const openTabs = makeOpenTabs({ activeId: "conv-a" });
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "default", openTabs })} />,
      );

      fireEvent.click(tabByTitle("Beta"));

      expect(openTabs.activate).toHaveBeenCalledTimes(1);
      expect(openTabs.activate).toHaveBeenCalledWith("conv-b");
      expect(openTabs.closeTab).not.toHaveBeenCalled();
    });

    it("clicking a tab's close control calls openTabs.closeTab and NOT activate (2.7/2.8)", () => {
      const openTabs = makeOpenTabs({ activeId: "conv-a" });
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "default", openTabs })} />,
      );

      const betaTab = tabByTitle("Beta");
      fireEvent.click(
        within(betaTab).getByRole("button", { name: "Close tab" }),
      );

      expect(openTabs.closeTab).toHaveBeenCalledTimes(1);
      expect(openTabs.closeTab).toHaveBeenCalledWith("conv-b");
      expect(openTabs.activate).not.toHaveBeenCalled();
    });

    it("opening the strip add picker lists addable conversations; selecting one calls addTab and closes the menu (2.9)", () => {
      const openTabs = makeOpenTabs();
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "default", openTabs })} />,
      );

      // No menu before the trigger is clicked.
      expect(screen.queryByRole("menu")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Add conversation" }));

      const menu = screen.getByRole("menu");
      const item = within(menu).getByRole("menuitem", { name: /Gamma/ });
      fireEvent.click(item);

      expect(openTabs.addTab).toHaveBeenCalledTimes(1);
      expect(openTabs.addTab).toHaveBeenCalledWith("conv-c");
      // The strip menu closes after a selection.
      expect(screen.queryByRole("menu")).toBeNull();
    });
  });

  describe("panes grid (panes layout)", () => {
    it("clicking an inactive pane's body calls openTabs.activate with that id (5.2)", () => {
      const openTabs = makeOpenTabs({ activeId: "conv-a" });
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "panes", openTabs })} />,
      );

      fireEvent.click(paneByTitle("Beta"));

      expect(openTabs.activate).toHaveBeenCalledTimes(1);
      expect(openTabs.activate).toHaveBeenCalledWith("conv-b");
    });

    it("clicking a pane's open-full control calls activate AND onLayoutChange('default') (4.7)", () => {
      const openTabs = makeOpenTabs({ activeId: "conv-a" });
      const onLayoutChange = vi.fn();
      renderWithQuery(
        <SessionContent
          {...makeProps({ layout: "panes", openTabs, onLayoutChange })}
        />,
      );

      const betaPane = paneByTitle("Beta");
      fireEvent.click(
        within(betaPane).getByRole("button", { name: "Open full" }),
      );

      expect(openTabs.activate).toHaveBeenCalledWith("conv-b");
      expect(onLayoutChange).toHaveBeenCalledWith("default");
    });

    it("clicking a pane's close control calls openTabs.closeTab and NOT activate (4.8)", () => {
      const openTabs = makeOpenTabs({ activeId: "conv-a" });
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "panes", openTabs })} />,
      );

      const betaPane = paneByTitle("Beta");
      fireEvent.click(
        within(betaPane).getByRole("button", { name: "Close pane" }),
      );

      expect(openTabs.closeTab).toHaveBeenCalledTimes(1);
      expect(openTabs.closeTab).toHaveBeenCalledWith("conv-b");
      expect(openTabs.activate).not.toHaveBeenCalled();
    });
  });

  describe("panes toolbar", () => {
    it("clicking the toolbar exit calls onLayoutChange('default') (6.4)", () => {
      const openTabs = makeOpenTabs();
      const onLayoutChange = vi.fn();
      renderWithQuery(
        <SessionContent
          {...makeProps({ layout: "panes", openTabs, onLayoutChange })}
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Exit panes" }));

      expect(onLayoutChange).toHaveBeenCalledWith("default");
    });

    it("selecting an addable in the toolbar add picker calls openTabs.addTab (6.2)", () => {
      const openTabs = makeOpenTabs();
      renderWithQuery(
        <SessionContent {...makeProps({ layout: "panes", openTabs })} />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Add pane" }));

      const menu = screen.getByRole("menu");
      fireEvent.click(within(menu).getByRole("menuitem", { name: /Gamma/ }));

      expect(openTabs.addTab).toHaveBeenCalledTimes(1);
      expect(openTabs.addTab).toHaveBeenCalledWith("conv-c");
    });
  });

  // The ⌘1–9 activation shortcut (8.1) is intentionally NOT re-exercised here:
  // it is covered by use-tab-pane-keyboard.test.tsx (the hook) + task 7.1 (its
  // mount in ConversationWorkspace) + the live test 8.1. Close-without-stopping
  // -the-agent (2.7/4.8) holds structurally because openTabs.closeTab only
  // mutates local working-set state (no agent/stop API is wired) — pinned by
  // use-open-tabs.test.ts.
});
