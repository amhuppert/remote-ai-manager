// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import SessionDetailPage from "./SessionDetailPage";
import type { SessionState, SessionDiff, TranscriptMessage } from "@/types";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";

// ---------------------------------------------------------------------------
// Shared mocks
// ---------------------------------------------------------------------------

vi.mock(
  "next/link",
  async () => (await import("@/test/component-mocks")).nextLinkMock,
);
vi.mock(
  "next/navigation",
  async () => (await import("@/test/component-mocks")).nextNavigationMock,
);
vi.mock(
  "@/hooks/useVoiceRecorder",
  async () => (await import("@/test/component-mocks")).voiceRecorderMock,
);
vi.mock(
  "@/hooks/useAppHotkey",
  async () => (await import("@/test/component-mocks")).appHotkeyMock,
);

// ---------------------------------------------------------------------------
// Infrastructure mocks — JSDOM limitations only
// ---------------------------------------------------------------------------

// ESM-only markdown deps — lightweight stubs
vi.mock("@/components/MarkdownContent", () => ({
  default: ({ content }: { content: string }) => <span>{content}</span>,
}));

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

// JSDOM has no layout engine — virtualizer needs a stub
const scrollToIndexMock = vi.fn();
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        key: i,
        start: i * 120,
        size: 120,
      })),
    getTotalSize: () => count * 120,
    measureElement: vi.fn(),
    scrollToIndex: scrollToIndexMock,
  }),
}));

// ---------------------------------------------------------------------------
// Hook mocks — external API calls / browser APIs unavailable in JSDOM
// ---------------------------------------------------------------------------

const sendPromptMock = vi.fn();
const abortClientMock = vi.fn();
vi.mock("@/hooks/use-send-prompt", () => ({
  useSendPrompt: () => ({ send: sendPromptMock, abortClient: abortClientMock }),
}));

const abortPromptMock = vi.fn();
vi.mock("@/hooks/use-abort-prompt", () => ({
  useAbortPrompt: () => abortPromptMock,
}));

// ---------------------------------------------------------------------------
// Query/Mutation mocks — API boundary
// ---------------------------------------------------------------------------

let testSession: SessionState | undefined;
let testMessages: TranscriptMessage[];
let testDiff: SessionDiff;
let testSessionPending: boolean;

vi.mock("@/lib/queries", () => ({
  useSessionQuery: () => ({ data: testSession, isPending: testSessionPending }),
  useConversationMessagesQuery: () => ({
    data: testMessages,
    isPending: false,
  }),
  useSessionDiffQuery: () => ({ data: testDiff, isPending: false }),
  useCommitsQuery: () => ({ data: [], isPending: false }),
  useConversationsQuery: () => ({ data: undefined, isPending: false }),
  useCommandsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
  useProjectCommandsQuery: () => ({
    data: undefined,
    isPending: false,
    isError: false,
  }),
  useActiveConversationsQuery: () => ({ data: undefined }),
  useNotificationsQuery: () => ({ data: undefined }),
  useReferenceDocumentsQuery: () => ({ data: [], isPending: false }),
  useReferenceDocumentContentQuery: () => ({ data: null, isPending: false }),
  useKiroDocTreeQuery: () => ({ data: undefined, isPending: false }),
  useKiroDocFileQuery: () => ({ data: undefined, isPending: false }),
  useProjectFilesQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
  useDebugLogEntryCountQuery: () => ({ data: 0, isPending: false }),
}));

vi.mock("@/lib/mutations", () => ({
  useDeleteSessionMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCommitMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useMergeMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useSmartMergeMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useResolveConflictsMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateConversationMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useArchiveConversationMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useFinalizeInitializationMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useTddToggleMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDebugModeToggleMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDebugRecordingMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useClearDebugLogsMutation: () => ({ mutate: vi.fn(), isPending: false }),
  ApiCallError: class extends Error {
    code?: string;
  },
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
  targetBranch: "main",
  parentSessionName: null,
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
      source: "cc",
      summary: null,
      archived: false,
      totalCostUsd: null,
      totalDurationMs: null,
      totalTurns: null,
      pendingQuestionId: null,
      pendingQuestions: null,
      forkedFrom: null,
      role: null,
      contextTokens: null,
      contextWindowMax: null,
      debugMode: null,
      machineSnapshot: null,
    },
  ],
  source: "cc" as const,
  objective: null,
  creationMode: "fast" as const,
  tddEnabled: true,
  workflow: null,
  workflowHistory: [],
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
  referenceDocuments: [],
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
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  testSession = baseSession;
  testMessages = sampleMessages;
  testDiff = emptyDiff;
  testSessionPending = false;

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

function renderPage(props?: {
  defaultEffort?: "low" | "medium" | "high" | "max";
}) {
  return renderWithQuery(
    <SessionDetailPage
      projectName="repo"
      sessionName="test-session"
      conversationId="conv-1"
      defaultModel="sonnet"
      {...props}
    />,
  );
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SessionDetailPage", () => {
  it("renders user and assistant messages with role indicators", () => {
    renderPage();
    expect(screen.getAllByText("You")).toHaveLength(2);
    expect(screen.getAllByText("Claude").length).toBeGreaterThanOrEqual(1);
  });

  it("renders message content text", () => {
    renderPage();
    expect(screen.getByText("Hello Claude")).toBeInTheDocument();
    expect(screen.getByText("Hello! How can I help?")).toBeInTheDocument();
    expect(screen.getByText("Fix the bug")).toBeInTheDocument();
  });

  it("renders empty state when no messages", () => {
    testMessages = [];
    renderPage();
    expect(screen.getByText("No messages yet")).toBeInTheDocument();
    expect(
      screen.getByText("Send a prompt to start the conversation."),
    ).toBeInTheDocument();
  });

  it("displays session info with branch name and prompt count", () => {
    renderPage();
    // Branch name visible in info strip (summary + details)
    expect(
      screen.getAllByText("csm/test-session").length,
    ).toBeGreaterThanOrEqual(1);
    // Prompt count rendered as text (info strip + mobile action menu)
    expect(screen.getAllByText("5").length).toBeGreaterThanOrEqual(1);
  });

  it("shows turn counter with position / total", () => {
    renderPage();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
  });

  it("shows 0 / 0 counter when no messages", () => {
    testMessages = [];
    renderPage();
    expect(screen.getByText("0 / 0")).toBeInTheDocument();
  });

  it("keeps nav buttons always enabled", () => {
    renderPage();
    const prevBtn = screen.getByTitle("Previous message");
    const nextBtn = screen.getByTitle("Next message");
    expect(prevBtn.hasAttribute("disabled")).toBe(false);
    expect(nextBtn.hasAttribute("disabled")).toBe(false);
  });

  it("disables send button when prompt text is empty", () => {
    renderPage();
    const sendBtn = screen.getByTitle("Send prompt");
    expect(sendBtn.hasAttribute("disabled")).toBe(true);
  });

  it("enables send button when prompt text is entered", () => {
    renderPage();
    const textarea = screen.getByPlaceholderText("Send a prompt to Claude...");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    const sendBtn = screen.getByTitle("Send prompt");
    expect(sendBtn.hasAttribute("disabled")).toBe(false);
  });

  it("prompt textarea accepts text input", () => {
    renderPage();
    const textarea = screen.getByPlaceholderText(
      "Send a prompt to Claude...",
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Fix the bug" } });
    expect(textarea.value).toBe("Fix the bug");
  });

  it("shows loading state when session query is pending", () => {
    testSessionPending = true;
    renderPage();
    expect(screen.getByText("Loading session...")).toBeInTheDocument();
  });

  describe("Escape key abort behavior", () => {
    /**
     * Helper to find the callback registered for a given hotkey ID.
     * useAppHotkey is called multiple times (one per hotkey);
     * we need the one registered for "abortPrompt".
     */
    function getAbortHotkeyCallback(): (e: KeyboardEvent) => void {
      const call = vi
        .mocked(useAppHotkey)
        .mock.calls.find(([id]) => id === "abortPrompt");
      expect(call).toBeDefined();
      return call![1];
    }

    it("sends abort when conversation is running on server even if sending=false", () => {
      // Simulate: conversation is running on server but no active SSE stream
      // (e.g., page refreshed while Claude was working)
      testSession = {
        ...baseSession,
        conversations: [
          { ...baseSession.conversations[0]!, status: "running" },
        ],
      };

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const abortCallback = getAbortHotkeyCallback();
      abortCallback({} as KeyboardEvent);

      expect(abortPromptMock).toHaveBeenCalled();
    });

    it("sends abort when conversation is waiting_for_input", () => {
      testSession = {
        ...baseSession,
        conversations: [
          { ...baseSession.conversations[0]!, status: "waiting_for_input" },
        ],
      };

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const abortCallback = getAbortHotkeyCallback();
      abortCallback({} as KeyboardEvent);

      expect(abortPromptMock).toHaveBeenCalled();
    });

    it("does NOT call abortClient when sending=false (no active SSE stream)", () => {
      testSession = {
        ...baseSession,
        conversations: [
          { ...baseSession.conversations[0]!, status: "running" },
        ],
      };

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const abortCallback = getAbortHotkeyCallback();
      abortCallback({} as KeyboardEvent);

      // abortClient should NOT be called — there's no SSE stream to abort
      expect(abortClientMock).not.toHaveBeenCalled();
      // but the server-side abort should still fire
      expect(abortPromptMock).toHaveBeenCalled();
    });

    it("does NOT send abort when conversation is idle", () => {
      // Conversation status is "new" (idle), not running
      testSession = {
        ...baseSession,
        conversations: [{ ...baseSession.conversations[0]!, status: "new" }],
      };

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const abortCallback = getAbortHotkeyCallback();
      abortCallback({} as KeyboardEvent);

      expect(abortPromptMock).not.toHaveBeenCalled();
    });
  });

  describe("fire-and-forget voice mode", () => {
    it("auto-submits prompt when fire-and-forget voice result arrives", () => {
      let capturedOnResult: ((text: string) => void) | undefined;
      vi.mocked(useVoiceRecorder).mockImplementation(((opts: {
        onResult: (text: string) => void;
      }) => {
        capturedOnResult = opts.onResult;
        return {
          isRecording: false,
          isProcessing: false,
          elapsedTime: 0,
          isAvailable: true,
          toggleRecording: vi.fn(),
          stopRecording: vi.fn(),
        };
      }) as typeof useVoiceRecorder);

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const ffCall = vi
        .mocked(useAppHotkey)
        .mock.calls.find(([id]) => id === "voiceFireAndForget");
      expect(ffCall).toBeDefined();
      ffCall![1]({} as KeyboardEvent);

      expect(capturedOnResult).toBeDefined();
      capturedOnResult!("Hello from voice");
      expect(sendPromptMock).toHaveBeenCalled();
    });

    it("does NOT auto-submit in normal voice mode (control)", () => {
      let capturedOnResult: ((text: string) => void) | undefined;
      vi.mocked(useVoiceRecorder).mockImplementation(((opts: {
        onResult: (text: string) => void;
      }) => {
        capturedOnResult = opts.onResult;
        return {
          isRecording: false,
          isProcessing: false,
          elapsedTime: 0,
          isAvailable: true,
          toggleRecording: vi.fn(),
          stopRecording: vi.fn(),
        };
      }) as typeof useVoiceRecorder);

      vi.mocked(useAppHotkey).mockClear();
      renderPage();

      const vtCall = vi
        .mocked(useAppHotkey)
        .mock.calls.find(([id]) => id === "voiceToggle");
      expect(vtCall).toBeDefined();
      vtCall![1]({} as KeyboardEvent);

      capturedOnResult!("Hello from voice");
      expect(sendPromptMock).not.toHaveBeenCalled();
    });
  });

  describe("scroll navigation", () => {
    it("scrolls to last message via virtualizer on initial load", () => {
      scrollToIndexMock.mockClear();
      renderPage();
      // Should use virtualizer.scrollToIndex to reach the last message (index 2)
      // with align: "end" and no animation
      expect(scrollToIndexMock).toHaveBeenCalledWith(2, {
        align: "end",
        behavior: "auto",
      });
    });

    it("navigate-to-end button scrolls to last message via virtualizer", () => {
      renderPage();
      scrollToIndexMock.mockClear();

      const lastBtn = screen.getByTitle("Last message");
      fireEvent.click(lastBtn);

      expect(scrollToIndexMock).toHaveBeenCalledWith(2, {
        align: "end",
        behavior: "auto",
      });
    });
  });

  describe("defaultEffort prop", () => {
    it("uses 'high' as initial effort when no defaultEffort is provided", () => {
      renderPage();
      const effortTrigger = document.querySelector(".effort-selector-trigger");
      expect(effortTrigger).toBeTruthy();
      expect(effortTrigger!.getAttribute("title")).toContain("High");
    });

    it("uses defaultEffort prop as initial effort when provided", () => {
      renderPage({ defaultEffort: "low" });
      const effortTrigger = document.querySelector(".effort-selector-trigger");
      expect(effortTrigger).toBeTruthy();
      expect(effortTrigger!.getAttribute("title")).toContain("Low");
    });
  });
});
