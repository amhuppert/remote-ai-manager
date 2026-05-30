// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderWithQuery } from "@/test/component-mocks";
import SessionContent from "@/features/session/conversation/SessionContent";
import type { ComponentProps } from "react";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";

// Stub heavy child components — they have their own tests and their internals
// are not part of SessionContent's behavior. We assert only on SessionContent's
// own conditional branches (root class name, sidebar mount predicate).
vi.mock("@/features/session/conversation/SessionInfoStrip", () => ({
  default: () => <div data-testid="stub-info-strip" />,
}));
vi.mock("@/features/session/conversation/RightPane", () => ({
  default: () => <div data-testid="stub-right-pane" />,
}));
vi.mock("@/features/session/conversation/ConversationPanelContainer", () => ({
  default: () => <div data-testid="stub-conversation-panel" />,
}));
vi.mock("@/features/session/sidebar/ConversationSidebar", () => ({
  default: () => <div data-testid="stub-conversation-sidebar" />,
}));
vi.mock("@/features/session/mobile/MobileInfoPanel", () => ({
  default: () => <div data-testid="stub-mobile-info-panel" />,
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
    objective: null,
    creationMode: "fast",
    tddEnabled: true,
    targetBranch: "main",
    parentSessionName: null,
    graphWorkflowExecution: null,
    graphWorkflowExecutionHistory: [],
    referenceDocuments: [],
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return {
    id: "conv-1",
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
    ...overrides,
  };
}

type Props = ComponentProps<typeof SessionContent>;

function makeProps(overrides: Partial<Props> = {}): Props {
  return {
    session: makeSession(),
    activeConversation: makeConversation(),
    conversations: undefined,
    projectName: "my-proj",
    sessionName: "sess-1",
    conversationId: "conv-1",
    statusDotClass: "status-dot-idle",
    displayStatus: "idle",
    contextPercent: null,
    buildContext: () => null,
    isFinished: false,
    targetBranch: "main",
    sidebarCollapsed: false,
    toggleSidebar: vi.fn(),
    mobileSidebarOpen: false,
    closeMobileSidebar: vi.fn(),
    layout: "default",
    mobilePanel: "chat",
    diff: { files: [], totalAdditions: 0, totalDeletions: 0 },
    commits: [],
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
    commitDisabled: false,
    onCommit: vi.fn(),
    onMerge: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  };
}

describe("SessionContent", () => {
  it("adds the 'finished' modifier class on the root layout when isFinished=true", () => {
    const { container } = renderWithQuery(
      <SessionContent {...makeProps({ isFinished: true })} />,
    );
    const layout = container.querySelector(".session-detail-layout");
    expect(layout).not.toBeNull();
    expect(layout!.classList.contains("finished")).toBe(true);
  });

  it("omits the 'finished' modifier class when isFinished=false", () => {
    const { container } = renderWithQuery(
      <SessionContent {...makeProps({ isFinished: false })} />,
    );
    const layout = container.querySelector(".session-detail-layout");
    expect(layout).not.toBeNull();
    expect(layout!.classList.contains("finished")).toBe(false);
  });

  it("does not render the ConversationSidebar when conversations=undefined", () => {
    const { queryByTestId, container } = renderWithQuery(
      <SessionContent {...makeProps({ conversations: undefined })} />,
    );
    expect(queryByTestId("stub-conversation-sidebar")).toBeNull();
    const main = container.querySelector("main.main");
    expect(main?.getAttribute("data-with-sidebar")).toBe("off");
  });

  it("renders the ConversationSidebar as a sibling of the detail layout when conversations are supplied", () => {
    const { getByTestId, container } = renderWithQuery(
      <SessionContent
        {...makeProps({ conversations: [makeConversation()] })}
      />,
    );
    const sidebar = getByTestId("stub-conversation-sidebar");
    expect(sidebar).toBeInTheDocument();
    const main = container.querySelector("main.main");
    expect(main?.getAttribute("data-with-sidebar")).toBe("on");
    // Sidebar lives at the top level of .main, not inside the content area.
    expect(sidebar.parentElement).toBe(main);
  });
});
