// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SessionDetailPage from "./SessionDetailPage";
import type { SessionState, SessionDiff, TranscriptMessage } from "@/types";

// Mock next/link
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// Mock next/navigation
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: routerPushMock,
  }),
}));

// Mock MarkdownContent to avoid pulling in react-markdown in tests
vi.mock("@/components/MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

// Mock MarkdownViewer to avoid pulling in react-markdown in tests
vi.mock("@/components/MarkdownViewer", () => ({
  default: ({
    content,
    isLoading,
  }: {
    content: string | null;
    isLoading: boolean;
  }) => (
    <div data-testid="markdown-viewer">
      {isLoading ? "Loading..." : (content ?? "No content")}
    </div>
  ),
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const baseSession: SessionState = {
  sessionName: "test-session",
  worktreePath: "/projects/repo/.worktrees/test-session",
  branchName: "csm/test-session",
  createdAt: "2024-06-15T10:00:00Z",
  lastActivityAt: "2024-06-15T12:00:00Z",
  archived: false,
  finished: false,
  conversations: [
    {
      id: "conv-1",
      name: null,
      claudeSessionId: null,
      transcriptPath: null,
      status: "new",
      promptCount: 5,
      createdAt: "2024-06-15T10:00:00Z",
      lastActivityAt: "2024-06-15T12:00:00Z",
      source: "csm",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      role: null,
    },
  ],
  source: "csm" as const,
  objective: null,
  creationMode: "fast" as const,
};

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

const sampleMessages: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Hello Claude" }],
    timestamp: "2024-06-15T10:01:00Z",
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "Hello! How can I help?" }],
    timestamp: "2024-06-15T10:01:05Z",
  },
  {
    role: "user",
    content: [{ type: "text", text: "Fix the bug" }],
    timestamp: "2024-06-15T10:02:00Z",
  },
];

// ---------------------------------------------------------------------------
// Mock data holders
// ---------------------------------------------------------------------------

let mockSession: SessionState | undefined = baseSession;
let mockMessages: TranscriptMessage[] = sampleMessages;
let mockDiff: SessionDiff = emptyDiff;
let mockSessionPending = false;
let mockMessagesPending = false;
let mockDiffPending = false;

// Mock queries
vi.mock("@/lib/queries", () => ({
  useSessionQuery: () => ({ data: mockSession, isPending: mockSessionPending }),
  useConversationMessagesQuery: () => ({
    data: mockMessages,
    isPending: mockMessagesPending,
  }),
  useSessionDiffQuery: () => ({ data: mockDiff, isPending: mockDiffPending }),
  useCommitsQuery: () => ({ data: [], isPending: false }),
  useConversationsQuery: () => ({ data: undefined, isPending: false }),
  useCommandsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
  useActiveConversationsQuery: () => ({ data: undefined }),
  useFocusDocQuery: () => ({ data: undefined, isPending: false }),
}));

// Mock unified panel store
vi.mock("@/stores/unified-panel.store", () => ({
  useUnifiedPanelOpen: () => false,
  useToggleUnifiedPanel: () => vi.fn(),
}));

// Mock mutations
vi.mock("@/lib/mutations", () => ({
  useDeleteSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCommitMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useMergeMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateConversationMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversationMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useFinalizeInitializationMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
}));

// Mock useSendPrompt
const sendPromptMock = vi.fn();
const abortClientMock = vi.fn();
vi.mock("@/hooks/use-send-prompt", () => ({
  useSendPrompt: () => ({ send: sendPromptMock, abortClient: abortClientMock }),
}));

// Mock useAbortPrompt
const abortPromptMock = vi.fn();
vi.mock("@/hooks/use-abort-prompt", () => ({
  useAbortPrompt: () => abortPromptMock,
}));

// Mock useVoiceRecorder
vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
  }),
}));

// Mock useAppHotkey
vi.mock("@/hooks/useAppHotkey", () => ({
  useAppHotkey: vi.fn(),
}));

// Configurable virtual items — null means "show all" (default for most tests).
// Set to a specific array in individual tests to simulate partial scroll state.
let mockVirtualItems:
  | { index: number; key: number; start: number; size: number }[]
  | null = null;

// Mock @tanstack/react-virtual — JSDOM has no layout so virtualizer renders nothing
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      mockVirtualItems ??
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 120,
        size: 120,
      })),
    getTotalSize: () => count * 120,
    measureElement: vi.fn(),
    scrollToIndex: vi.fn(),
  }),
}));

// Mock session-detail store — provide real-ish defaults
vi.mock("@/stores/session-detail.store", () => ({
  useLayout: () => "default",
  useMobilePanel: () => "chat",
  useSending: () => false,
  useIsVoiceRecording: () => false,
  usePromptPlaceholder: () => null,
  usePromptError: () => null,
  useOptimisticMessages: () => [],
  useMessageCountBeforeSubmit: () => 0,
  useCurrentMsgIndex: () => 0,
  useShowDeleteConfirm: () => false,
  useShowCommitDialog: () => false,
  useShowMergeDialog: () => false,
  useInfoExpanded: () => false,
  useSidebarCollapsed: () => false,
  useSwitchLayout: () => vi.fn(),
  useHydrateLayout: () => vi.fn(),
  useSwitchMobilePanel: () => vi.fn(),
  useSubmitPrompt: () => vi.fn(),
  useReceiveStreamContent: () => vi.fn(),
  useCompletePrompt: () => vi.fn(),
  useFailPrompt: () => vi.fn(),
  useDismissError: () => vi.fn(),
  useReconcileMessages: () => vi.fn(),
  useNavigateToMessage: () => vi.fn(),
  useStartRecording: () => vi.fn(),
  useStopRecording: () => vi.fn(),
  useShowPlaceholderAction: () => vi.fn(),
  useClearPlaceholder: () => vi.fn(),
  useRequestCommit: () => vi.fn(),
  useCancelCommit: () => vi.fn(),
  useRequestMerge: () => vi.fn(),
  useCancelMerge: () => vi.fn(),
  useRequestDeleteSession: () => vi.fn(),
  useCancelDeleteSessionDetail: () => vi.fn(),
  useToggleInfoStrip: () => vi.fn(),
  useToggleSidebar: () => vi.fn(),
  useHydrateSidebar: () => vi.fn(),
  useClearConversationMessages: () => vi.fn(),
  useResetSessionDetailStore: () => vi.fn(),
  useEditingIndex: () => null,
  useStartEditing: () => vi.fn(),
  useCancelEditing: () => vi.fn(),
  useSetPendingForkPrompt: () => vi.fn(),
  useConsumePendingForkPrompt: () => vi.fn(),
  usePendingQuestions: () => null,
  usePendingQuestionId: () => null,
  useCurrentQuestionIndex: () => 0,
  useShowQuestions: () => vi.fn(),
  useNavigateQuestion: () => vi.fn(),
  useClearQuestions: () => vi.fn(),
  useRightPaneTab: () => "diff",
  useSwitchRightPaneTab: () => vi.fn(),
}));

// Mock IntersectionObserver
beforeEach(() => {
  vi.clearAllMocks();
  mockSession = baseSession;
  mockMessages = sampleMessages;
  mockDiff = emptyDiff;
  mockSessionPending = false;
  mockMessagesPending = false;
  mockDiffPending = false;
  mockVirtualItems = null; // reset to "show all" default

  globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  }));
  Element.prototype.scrollIntoView = vi.fn();
  const storage: Record<string, string> = {};
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => {
      storage[key] = val;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
  });
});

function renderWithQuery(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

// ===========================================================================
// SessionDetailPage Tests
// ===========================================================================

describe("SessionDetailPage", () => {
  it("renders user messages with role indicator (Req 6.1, 3.1)", () => {
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const roles = screen.getAllByText("You");
    expect(roles.length).toBe(2);
    const assistantRoles = screen.getAllByText("Claude");
    expect(assistantRoles.length).toBeGreaterThanOrEqual(1);
  });

  it("renders message content text (Req 6.1)", () => {
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    expect(screen.getByText("Hello Claude")).toBeDefined();
    expect(screen.getByText("Hello! How can I help?")).toBeDefined();
    expect(screen.getByText("Fix the bug")).toBeDefined();
  });

  it("renders empty state when no messages (Req 6.2)", () => {
    mockMessages = [];
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    expect(screen.getByText("No messages yet")).toBeDefined();
    expect(
      screen.getByText("Send a prompt to start the conversation."),
    ).toBeDefined();
  });

  it("displays session info strip with branch, prompts, worktree (Req 3.2)", () => {
    const { container } = renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const branchEls = container.querySelectorAll(".si-val");
    const branchTexts = Array.from(branchEls).map((el) => el.textContent);
    expect(branchTexts).toContain("csm/test-session");
    expect(branchTexts).toContain("5");
    expect(branchTexts).toContain("/projects/repo/.worktrees/test-session");
  });

  it("shows message counter with position / total (Req 6.3)", () => {
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    expect(screen.getByText("1 / 2")).toBeDefined();
  });

  it("shows 0 / 0 counter when no messages", () => {
    mockMessages = [];
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    expect(screen.getByText("0 / 0")).toBeDefined();
  });

  it("keeps nav buttons always enabled (Req 6.4, 6.5)", () => {
    mockVirtualItems = [{ index: 0, key: 0, start: 0, size: 120 }];
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const prevBtn = screen.getByTitle("Previous message");
    const nextBtn = screen.getByTitle("Next message");
    expect(prevBtn.hasAttribute("disabled")).toBe(false);
    expect(nextBtn.hasAttribute("disabled")).toBe(false);
  });

  it("disables send button when prompt text is empty (Req 3.5)", () => {
    const { container } = renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const sendBtn = container.querySelector(".send-btn");
    expect(sendBtn?.hasAttribute("disabled")).toBe(true);
  });

  it("renders LayoutSwitcher buttons (Req 3.4)", () => {
    const { container } = renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const layoutBtns = container.querySelectorAll(".layout-btn");
    expect(layoutBtns.length).toBe(4);
  });

  it("enables send button when prompt text is entered (Req 3.5)", () => {
    const { container } = renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const textarea = container.querySelector(".prompt-textarea")!;
    fireEvent.change(textarea, { target: { value: "Hello" } });
    const sendBtn = container.querySelector(".send-btn");
    expect(sendBtn?.hasAttribute("disabled")).toBe(false);
  });

  it("prompt textarea accepts text input (Req 3.4)", () => {
    const { container } = renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    const textarea = container.querySelector(
      ".prompt-textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });
    expect(textarea.value).toBe("Fix the bug");
  });

  it("shows loading state when queries are pending", () => {
    mockSessionPending = true;
    renderWithQuery(
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />,
    );
    expect(screen.getByText("Loading session...")).toBeDefined();
  });
});
