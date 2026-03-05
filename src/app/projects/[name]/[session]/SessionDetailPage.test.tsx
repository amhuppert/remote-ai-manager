// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SessionDetailPage from "./SessionDetailPage";
import type { SessionState, SessionDiff, TranscriptMessage } from "@/types";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";

// ---------------------------------------------------------------------------
// Infrastructure mocks — JSDOM limitations only
// ---------------------------------------------------------------------------

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

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

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
    scrollToIndex: vi.fn(),
  }),
}));

// ---------------------------------------------------------------------------
// Hook mocks — external API calls / browser APIs unavailable in JSDOM
// ---------------------------------------------------------------------------

const sendPromptMock = vi.fn();
vi.mock("@/hooks/use-send-prompt", () => ({
  useSendPrompt: () => ({ send: sendPromptMock, abortClient: vi.fn() }),
}));

vi.mock("@/hooks/use-abort-prompt", () => ({
  useAbortPrompt: () => vi.fn(),
}));

vi.mock("@/hooks/useVoiceRecorder", () => ({
  useVoiceRecorder: vi.fn(() => ({
    isRecording: false,
    isProcessing: false,
    elapsedTime: 0,
    isAvailable: false,
    toggleRecording: vi.fn(),
    stopRecording: vi.fn(),
  })),
}));

vi.mock("@/hooks/useAppHotkey", () => ({
  useAppHotkey: vi.fn(),
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
  useFocusDocQuery: () => ({ data: undefined, isPending: false }),
  useKiroDocTreeQuery: () => ({ data: undefined, isPending: false }),
  useKiroDocFileQuery: () => ({ data: undefined, isPending: false }),
  useProjectFilesQuery: () => ({
    data: undefined,
    isLoading: false,
    error: null,
  }),
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
    },
  ],
  source: "cc" as const,
  objective: null,
  creationMode: "fast" as const,
  workflow: null,
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

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <SessionDetailPage
        projectName="repo"
        sessionName="test-session"
        conversationId="conv-1"
        defaultModel="sonnet"
      />
    </QueryClientProvider>,
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
    expect(screen.getByText("Hello Claude")).toBeDefined();
    expect(screen.getByText("Hello! How can I help?")).toBeDefined();
    expect(screen.getByText("Fix the bug")).toBeDefined();
  });

  it("renders empty state when no messages", () => {
    testMessages = [];
    renderPage();
    expect(screen.getByText("No messages yet")).toBeDefined();
    expect(
      screen.getByText("Send a prompt to start the conversation."),
    ).toBeDefined();
  });

  it("displays session info with branch name and prompt count", () => {
    renderPage();
    // Branch name visible in info strip (summary + details)
    expect(
      screen.getAllByText("csm/test-session").length,
    ).toBeGreaterThanOrEqual(1);
    // Prompt count rendered as text
    expect(screen.getByText("5")).toBeDefined();
  });

  it("shows turn counter with position / total", () => {
    renderPage();
    expect(screen.getByText("1 / 2")).toBeDefined();
  });

  it("shows 0 / 0 counter when no messages", () => {
    testMessages = [];
    renderPage();
    expect(screen.getByText("0 / 0")).toBeDefined();
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
    expect(screen.getByText("Loading session...")).toBeDefined();
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

    it("does NOT auto-submit in normal voice mode", () => {
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
});
