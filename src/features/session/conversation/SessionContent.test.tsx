// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import SessionContent from "@/features/session/conversation/SessionContent";
import type { ComponentProps } from "react";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { OpenTabsApi } from "@/features/session/tabs/use-open-tabs";

// Stub heavy child components — they have their own tests and their internals
// are not part of SessionContent's behavior. We assert only on SessionContent's
// own conditional branches (root class name, chrome-free boundary).
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
vi.mock("@/features/session/tabs/ConversationTabStrip", () => ({
  default: () => <div data-testid="stub-tab-strip" />,
}));
vi.mock("@/features/session/tabs/AddConversationMenu", () => ({
  default: () => <div data-testid="stub-add-menu" />,
}));
vi.mock("@/features/session/panes/PanesGrid", () => ({
  default: ({
    onOpenFull,
    onExit,
  }: {
    onOpenFull: (id: string) => void;
    onExit: () => void;
  }) => (
    <div data-testid="stub-panes-grid">
      <button
        type="button"
        data-testid="stub-pane-open-full"
        onClick={() => onOpenFull("conv-1")}
      />
      <button type="button" data-testid="stub-panes-exit" onClick={onExit} />
    </div>
  ),
}));

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
    creationMode: "normal",
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
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    lastSeenAlignmentVersion: null,
    pendingAgentNotices: [],
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

function makeOpenTabs(overrides: Partial<OpenTabsApi> = {}): OpenTabsApi {
  return {
    workingSet: [makeActiveConversation()],
    addableConversations: [],
    activeId: "conv-1",
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
    conversationId: "conv-1",
    statusDotClass: "status-dot-idle",
    displayStatus: "idle",
    contextPercent: null,
    buildContext: () => null,
    isFinished: false,
    targetBranch: "main",
    layout: "split",
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

describe("SessionContent", () => {
  it("flags the finished state on the root layout when isFinished=true", () => {
    const { container } = renderWithQuery(
      <SessionContent {...makeProps({ isFinished: true })} />,
    );
    const layout = container.querySelector(".session-detail-layout");
    expect(layout).not.toBeNull();
    expect(layout!.getAttribute("data-finished")).toBe("true");
  });

  it("clears the finished state when isFinished=false", () => {
    const { container } = renderWithQuery(
      <SessionContent {...makeProps({ isFinished: false })} />,
    );
    const layout = container.querySelector(".session-detail-layout");
    expect(layout).not.toBeNull();
    expect(layout!.getAttribute("data-finished")).toBe("false");
  });

  it("renders the detail layout as its root, without page chrome or the rail", () => {
    const { container } = renderWithQuery(<SessionContent {...makeProps()} />);
    expect(
      container.firstElementChild?.classList.contains("session-detail-layout"),
    ).toBe(true);
    expect(container.querySelector("main.main")).toBeNull();
    expect(
      container.querySelector('[aria-label="Collapse sidebar"]'),
    ).toBeNull();
  });

  it("renders the prompt composer exactly once in a pinned row", () => {
    const { container } = renderWithQuery(
      <SessionContent
        {...makeProps({
          promptInputSlot: <div data-testid="composer-slot" />,
        })}
      />,
    );
    expect(
      container.querySelectorAll('[data-testid="composer-slot"]').length,
    ).toBe(1);
    expect(
      container.querySelector('[data-testid="composer-slot"]')?.parentElement ??
        null,
    ).not.toBeNull();
  });

  it("pins the composer as a sibling of the content area, not inside it", () => {
    const { container } = renderWithQuery(
      <SessionContent
        {...makeProps({
          promptInputSlot: <div data-testid="composer-slot" />,
        })}
      />,
    );
    const contentArea = container.querySelector(".session-content-area");
    const composerRow =
      container.querySelector('[data-testid="composer-slot"]')?.parentElement ??
      null;
    const slot = container.querySelector('[data-testid="composer-slot"]');

    expect(contentArea).not.toBeNull();
    expect(composerRow).not.toBeNull();
    expect(slot).not.toBeNull();

    // The composer lives in the pinned row alongside the content area —
    // never inside the content area (that is the lift contract, 7.1/7.4).
    expect(composerRow!.contains(slot)).toBe(true);
    expect(composerRow!.previousElementSibling).toBe(contentArea);
    expect(contentArea!.contains(slot)).toBe(false);
  });

  it("wraps the content area and composer in one positioned stage so the question overlay can anchor (the AskUserQuestion overlay is position:absolute and needs a positioned ancestor spanning the conversation)", () => {
    const { container } = renderWithQuery(
      <SessionContent
        {...makeProps({
          promptInputSlot: <div data-testid="composer-slot" />,
        })}
      />,
    );
    const layout = container.querySelector(".session-detail-layout");
    const stage = container.querySelector(".conversation-docked-stage");
    const contentArea = container.querySelector(".session-content-area");
    const composerRow =
      container.querySelector('[data-testid="composer-slot"]')?.parentElement ??
      null;

    expect(stage).not.toBeNull();
    // The stage is a direct child of the layout and spans both the conversation
    // content and the composer, so the absolutely-positioned overlay rendered in
    // the composer row anchors to a box that covers the conversation.
    expect(stage!.parentElement).toBe(layout);
    expect(stage!.contains(contentArea)).toBe(true);
    expect(stage!.contains(composerRow)).toBe(true);
  });

  it.each(["split", "conversation", "diff", "panes"] as const)(
    "renders the shared composer in the %s layout",
    (layout) => {
      const { container } = renderWithQuery(
        <SessionContent
          {...makeProps({
            layout,
            promptInputSlot: <div data-testid="composer-slot" />,
          })}
        />,
      );
      expect(
        container.querySelectorAll('[data-testid="composer-slot"]').length,
      ).toBe(1);
    },
  );

  it("preserves the composer's content verbatim in the pinned row (7.4)", () => {
    const { container } = renderWithQuery(
      <SessionContent
        {...makeProps({
          promptInputSlot: (
            <button data-testid="composer-slot" type="button">
              Send prompt
            </button>
          ),
        })}
      />,
    );
    const composerRow =
      container.querySelector('[data-testid="composer-slot"]')?.parentElement ??
      null;
    const slot = composerRow?.querySelector('[data-testid="composer-slot"]');
    expect(slot).not.toBeNull();
    expect(slot!.tagName).toBe("BUTTON");
    expect(slot!.textContent).toBe("Send prompt");
  });

  describe("tab strip + panes grid by layout", () => {
    it("renders the tab strip above the content area in a non-panes layout with a non-empty working set (2.1)", () => {
      const { container } = renderWithQuery(
        <SessionContent
          {...makeProps({ layout: "split", openTabs: makeOpenTabs() })}
        />,
      );
      const strip = container.querySelector('[data-testid="stub-tab-strip"]');
      const contentArea = container.querySelector(".session-content-area");
      expect(strip).not.toBeNull();
      expect(contentArea).not.toBeNull();
      // The strip is a previous sibling of the content area — it precedes it in
      // DOM order within the detail layout.
      expect(
        strip!.compareDocumentPosition(contentArea!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // The panel still renders inside the content area in a non-panes layout.
      expect(
        contentArea!.querySelector('[data-testid="stub-conversation-panel"]'),
      ).not.toBeNull();
      // No panes grid in a non-panes layout.
      expect(
        container.querySelector('[data-testid="stub-panes-grid"]'),
      ).toBeNull();
    });

    it("renders the panes grid and not the panel/right-pane in the panes layout (3.2)", () => {
      const { container } = renderWithQuery(
        <SessionContent
          {...makeProps({ layout: "panes", openTabs: makeOpenTabs() })}
        />,
      );
      expect(
        container.querySelector('[data-testid="stub-panes-grid"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="stub-conversation-panel"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="stub-right-pane"]'),
      ).toBeNull();
      // The tab strip is hidden while panes are active.
      expect(
        container.querySelector('[data-testid="stub-tab-strip"]'),
      ).toBeNull();
    });

    it("renders neither strip nor grid and keeps the panel when openTabs is undefined (per-conversation route)", () => {
      const { container } = renderWithQuery(
        <SessionContent {...makeProps({ layout: "split" })} />,
      );
      expect(
        container.querySelector('[data-testid="stub-tab-strip"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="stub-panes-grid"]'),
      ).toBeNull();
      expect(
        container.querySelector('[data-testid="stub-conversation-panel"]'),
      ).not.toBeNull();
    });

    it("does not render the strip when openTabs is present but the working set is empty", () => {
      const { container } = renderWithQuery(
        <SessionContent
          {...makeProps({
            layout: "split",
            openTabs: makeOpenTabs({ workingSet: [] }),
          })}
        />,
      );
      expect(
        container.querySelector('[data-testid="stub-tab-strip"]'),
      ).toBeNull();
    });

    it("maximizing a pane activates it and drops to the conversation-only layout (not the diff-split layout)", () => {
      const onLayoutChange = vi.fn();
      const openTabs = makeOpenTabs();
      const { getByTestId } = renderWithQuery(
        <SessionContent
          {...makeProps({ layout: "panes", openTabs, onLayoutChange })}
        />,
      );

      fireEvent.click(getByTestId("stub-pane-open-full"));

      expect(openTabs.activate).toHaveBeenCalledWith("conv-1");
      expect(onLayoutChange).toHaveBeenCalledWith("conversation");
    });

    it("still renders the shared pinned composer in the panes layout (4.9 / 5.1)", () => {
      const { container } = renderWithQuery(
        <SessionContent
          {...makeProps({
            layout: "panes",
            openTabs: makeOpenTabs(),
            promptInputSlot: <div data-testid="composer-slot" />,
          })}
        />,
      );
      const composerRow =
        container.querySelector('[data-testid="composer-slot"]')
          ?.parentElement ?? null;
      expect(composerRow).not.toBeNull();
      expect(
        composerRow!.querySelector('[data-testid="composer-slot"]'),
      ).not.toBeNull();
    });
  });
});
