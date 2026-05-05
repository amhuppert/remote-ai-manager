// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { screen, fireEvent } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import ConversationDetailPage from "./ConversationDetailPage";
import type { SessionState, SessionDiff, TranscriptMessage } from "@/types";
import { useVoiceRecorder } from "@/hooks/useVoiceRecorder";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { makeFinalAnswer } from "@/lib/workflows/collaboration/test-fixtures";

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

// JSDOM doesn't implement Element.scrollTo, which the panel uses for nav.
if (!Element.prototype.scrollTo) {
  Element.prototype.scrollTo = function () {} as Element["scrollTo"];
}

// Tiptap depends on layout APIs jsdom doesn't implement; render a plain
// <textarea> that satisfies the same imperative handle and props contract.
vi.mock("./PromptEditor", async () => {
  const React = await import("react");
  type Props = {
    value: string;
    onChange: (text: string) => void;
    onSubmit: () => void;
    placeholder?: string;
    disabled?: boolean;
    readOnly?: boolean;
    title?: string;
  };
  const PromptEditor = React.forwardRef(function MockPromptEditor(
    props: Props,
    ref: React.Ref<unknown>,
  ) {
    // Mirror Tiptap's behavior: imperative mutations update an internal value
    // synchronously (so serialize() sees them in the same tick), and also
    // notify React via onChange.
    const internalRef = React.useRef(props.value);
    React.useEffect(() => {
      internalRef.current = props.value;
    }, [props.value]);
    React.useImperativeHandle(
      ref,
      () => ({
        serialize: () => ({ prompt: internalRef.current, images: [] }),
        clear: () => {
          internalRef.current = "";
          props.onChange("");
        },
        focus: () => {},
        insertText: (text: string) => {
          internalRef.current = internalRef.current + text;
          props.onChange(internalRef.current);
        },
        editor: null,
      }),
      [props.onChange],
    );
    return (
      <textarea
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            props.onSubmit();
          }
        }}
        placeholder={props.placeholder}
        disabled={props.disabled}
        readOnly={props.readOnly}
        title={props.title}
      />
    );
  });
  return { PromptEditor };
});

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
let testCollaborationEnvelopes: Array<{
  workflowId: string;
  status: "running" | "paused" | "completed" | "failed";
  phase: string;
  featureSnapshot: { conversationId?: string } & Record<string, unknown>;
}>;

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
  useCollaborationListQuery: () => ({
    data: testCollaborationEnvelopes,
    isPending: false,
  }),
  useCollaborationArtifactQuery: () => ({
    data: undefined,
    isPending: false,
  }),
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
  useSessionMcpConfigQuery: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  }),
  useConversationMcpConfigQuery: () => ({
    data: undefined,
    isPending: true,
    isError: false,
    error: null,
  }),
}));

const collaborationStartMutateMock = vi.fn();
const collaborationStopMutateMock = vi.fn();
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
  useDebugPhaseMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useDebugRecordingMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useClearDebugLogsMutation: () => ({ mutate: vi.fn(), isPending: false }),
  useCollaborationStartMutation: () => ({
    mutate: collaborationStartMutateMock,
    isPending: false,
  }),
  useCollaborationResumeMutation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useCollaborationStopMutation: () => ({
    mutate: collaborationStopMutateMock,
    isPending: false,
  }),
  ApiCallError: class extends Error {
    code?: string;
  },
  useToggleMcpServerMutation: () => ({ mutate: vi.fn() }),
  useResetMcpServerMutation: () => ({ mutate: vi.fn() }),
  useToggleMcpToolMutation: () => ({ mutate: vi.fn() }),
  useResetMcpToolMutation: () => ({ mutate: vi.fn() }),
  useRefreshMcpToolsMutation: () => ({ mutate: vi.fn() }),
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
      agentBackend: "claude" as const,
      backendRef: null,
    },
  ],
  source: "cc" as const,
  objective: null,
  creationMode: "fast" as const,
  tddEnabled: true,
  graphWorkflowExecution: null,
  graphWorkflowExecutionHistory: [],
  referenceDocuments: [],
};

const emptyDiff: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

function makeCollabFeatureSnapshot(
  conversationId: string,
  overrides: Record<string, unknown> = {},
): { conversationId: string } & Record<string, unknown> {
  return {
    conversationId,
    mode: "asymmetric",
    brief: "Decide on caching strategy.",
    primaryAgentBackend: "claude",
    negotiationRounds: 3,
    negotiationRoundsCompleted: 0,
    autonomousResolutionThreshold: "major",
    artifacts: [],
    userAnswersByQuestionId: {},
    ...overrides,
  };
}

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
  testCollaborationEnvelopes = [];

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
    <ConversationDetailPage
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

describe("ConversationDetailPage", () => {
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

  it("shows message counter with position / total", () => {
    renderPage();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
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
    const sendBtns = screen.getAllByTitle("Send prompt");
    expect(sendBtns.length).toBeGreaterThan(0);
    sendBtns.forEach((btn) => {
      expect(btn.hasAttribute("disabled")).toBe(true);
    });
  });

  it("enables send button when prompt text is entered", () => {
    renderPage();
    const textarea = screen.getByPlaceholderText("Send a prompt to Claude...");
    fireEvent.change(textarea, { target: { value: "Hello" } });
    const sendBtns = screen.getAllByTitle("Send prompt");
    expect(sendBtns.length).toBeGreaterThan(0);
    sendBtns.forEach((btn) => {
      expect(btn.hasAttribute("disabled")).toBe(false);
    });
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
    it("snaps the panel to its bottom on initial load (stick-to-bottom)", () => {
      // Spy on Element.scrollTop assignment so we can verify the layout effect
      // sets it to scrollHeight when stick-to-bottom is engaged.
      const scrollTopSetter = vi.fn();
      const originalDescriptor = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        get() {
          return 0;
        },
        set(v: number) {
          scrollTopSetter(v);
        },
      });
      try {
        renderPage();
        // Layout effect should have written to scrollTop at least once while
        // stick-to-bottom was engaged.
        expect(scrollTopSetter).toHaveBeenCalled();
      } finally {
        if (originalDescriptor) {
          Object.defineProperty(
            Element.prototype,
            "scrollTop",
            originalDescriptor,
          );
        }
      }
    });

    it("Last message button calls scrollTo on the panel with smooth behavior", () => {
      const scrollToSpy = vi.fn();
      const original = Element.prototype.scrollTo;
      Element.prototype.scrollTo = scrollToSpy as Element["scrollTo"];
      try {
        renderPage();
        scrollToSpy.mockClear();

        const lastBtn = screen.getByTitle("Last message");
        fireEvent.click(lastBtn);

        // Find the click-driven call (top: scrollHeight which is 0 in jsdom,
        // behavior: "smooth"). Stick-to-bottom uses scrollTop assignment, not
        // scrollTo, so any scrollTo call here is from the button handler.
        const smoothCall = scrollToSpy.mock.calls.find(
          (call) =>
            typeof call[0] === "object" &&
            call[0] !== null &&
            (call[0] as { behavior?: string }).behavior === "smooth",
        );
        expect(smoothCall).toBeDefined();
      } finally {
        Element.prototype.scrollTo = original;
      }
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

  describe("/collab config row", () => {
    it("shows CollabConfigRow above the textarea when prompt starts with /collab", () => {
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      );
      fireEvent.change(textarea, { target: { value: "/collab " } });

      expect(
        screen.getByRole("region", { name: "Collaboration configuration" }),
      ).toBeInTheDocument();
    });

    it("does not show CollabConfigRow for non-/collab prompts", () => {
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      );
      fireEvent.change(textarea, { target: { value: "Fix the bug" } });

      expect(
        screen.queryByRole("region", { name: "Collaboration configuration" }),
      ).toBeNull();
    });

    it("submitting a /collab prompt routes to collaboration start, not sendPrompt", () => {
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      );
      fireEvent.change(textarea, {
        target: { value: "/collab refactor the auth flow" },
      });

      const sendBtn = screen.getAllByTitle("Send prompt")[0]!;
      fireEvent.click(sendBtn);

      expect(collaborationStartMutateMock).toHaveBeenCalledTimes(1);
      const args = collaborationStartMutateMock.mock.calls[0]![0] as {
        brief: string;
        negotiationRounds: number;
        conversationId: string;
      };
      expect(args.brief).toBe("refactor the auth flow");
      expect(args.conversationId).toBe("conv-1");
      expect(typeof args.negotiationRounds).toBe("number");
      expect(sendPromptMock).not.toHaveBeenCalled();
    });

    it("dismiss button removes /collab from the prompt text", () => {
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      ) as HTMLTextAreaElement;
      fireEvent.change(textarea, {
        target: { value: "/collab refactor the auth flow" },
      });

      const dismissBtn = screen.getByLabelText("Dismiss /collab");
      fireEvent.click(dismissBtn);

      expect(textarea.value).toBe("refactor the auth flow");
      expect(
        screen.queryByRole("region", { name: "Collaboration configuration" }),
      ).toBeNull();
    });
  });

  describe("blocks normal input during active /collab", () => {
    it("makes the textarea read-only with a tooltip when a collab is running for the current conversation", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      ) as HTMLTextAreaElement;
      expect(textarea.readOnly).toBe(true);
      expect(textarea.title).toContain("collaboration in progress");
    });

    it("does not lock the textarea for terminal collabs", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-done",
          status: "completed",
          phase: "synthesis",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      ) as HTMLTextAreaElement;
      expect(textarea.readOnly).toBe(false);
    });

    it("renders a CollabPassage in the conversation when an active collab exists", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      expect(
        screen.getByLabelText("Collaboration passage"),
      ).toBeInTheDocument();
    });

    it("hides the normal conversation typing indicator while a collab is active", () => {
      testSession = {
        ...baseSession,
        conversations: [
          {
            ...baseSession.conversations[0]!,
            status: "running",
          },
        ],
      };
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];

      renderPage();

      expect(
        screen.getByLabelText("Collaboration passage"),
      ).toBeInTheDocument();
      expect(document.querySelector(".typing-indicator")).toBeNull();
      expect(document.querySelector(".streaming-indicator")).toBeNull();
    });

    it("renders the CollabPassage as a virtualized message-list row, not after the list", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const passage = screen.getByLabelText("Collaboration passage");
      const row = passage.closest(
        '[data-collab-row="true"]',
      ) as HTMLElement | null;
      expect(row).not.toBeNull();
      expect(row!.style.position).toBe("absolute");
    });

    it("inserts the CollabPassage immediately after the latest /collab user message", () => {
      testMessages = [
        {
          role: "user",
          content: [{ type: "text", text: "Hello Claude" }],
          timestamp: "2024-06-15T10:00:00Z",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Hi" }],
          timestamp: "2024-06-15T10:00:05Z",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "/collab investigate the regression" },
          ],
          timestamp: "2024-06-15T10:01:00Z",
        },
        {
          role: "user",
          content: [{ type: "text", text: "another message after" }],
          timestamp: "2024-06-15T10:02:00Z",
        },
      ];
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const passage = screen.getByLabelText("Collaboration passage");
      const collabRow = passage.closest(
        '[data-collab-row="true"]',
      ) as HTMLElement | null;
      expect(collabRow).not.toBeNull();
      const collabIndex = Number(collabRow!.getAttribute("data-index"));
      // /collab is at displayMessages index 2; the collab row must sit at
      // virtualizer index 3 — directly after that user message — so the
      // subsequent message ("another message after") shifts to index 4.
      expect(collabIndex).toBe(3);
    });

    it("does not render a CollabPassage when no active collab exists", () => {
      testCollaborationEnvelopes = [];
      renderPage();
      expect(screen.queryByLabelText("Collaboration passage")).toBeNull();
    });

    it("anchors the CollabPassage after a /collab user message stored as a command block", () => {
      testMessages = [
        {
          role: "user",
          content: [
            {
              type: "command",
              name: "/collab",
              args: "investigate the regression",
            },
          ],
          timestamp: "2024-06-15T10:00:00Z",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "final answer" }],
          timestamp: "2024-06-15T10:01:00Z",
        },
        {
          role: "user",
          content: [
            { type: "text", text: "Do you have a conversation history" },
          ],
          timestamp: "2024-06-15T10:02:00Z",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Yes I can see it" }],
          timestamp: "2024-06-15T10:03:00Z",
        },
      ];
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const passage = screen.getByLabelText("Collaboration passage");
      const collabRow = passage.closest(
        '[data-collab-row="true"]',
      ) as HTMLElement | null;
      expect(collabRow).not.toBeNull();
      const collabIndex = Number(collabRow!.getAttribute("data-index"));
      expect(collabIndex).toBe(1);
    });

    it("exposes a Stop control while a collaboration is active", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      expect(screen.getByLabelText("Stop collaboration")).toBeInTheDocument();
    });

    it("calls the stop mutation with the conversationId when Stop is clicked", () => {
      collaborationStopMutateMock.mockClear();
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const stopButton = screen.getByLabelText("Stop collaboration");
      fireEvent.click(stopButton);
      expect(collaborationStopMutateMock).toHaveBeenCalledTimes(1);
      expect(collaborationStopMutateMock.mock.calls[0]![0]).toEqual({
        conversationId: "conv-1",
      });
    });

    it("keeps Stop available when a collaboration is paused for user input", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-paused",
          status: "paused",
          phase: "asymmetric_paused_for_user",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      expect(screen.getByLabelText("Stop collaboration")).toBeInTheDocument();
    });

    it("does not lock the textarea when active collab belongs to a different conversation", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-other",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("different-conv"),
        },
      ];
      renderPage();
      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      ) as HTMLTextAreaElement;
      expect(textarea.readOnly).toBe(false);
    });

    // The phase strip is portaled into a sticky target at the top of the
    // conversation panel, so there is exactly one strip in the DOM whether
    // the run is active or terminal — and it lives inside the pinned target.
    it("renders the phase strip inside the pinned-top target while a collab is running", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-running",
          status: "running",
          phase: "round-1",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const pinned = document.querySelectorAll(
        ".collab-pinned-top-target .collab-phase-strip",
      );
      const allStrips = document.querySelectorAll(".collab-phase-strip");
      expect(pinned).toHaveLength(1);
      expect(allStrips).toHaveLength(1);
    });

    it("renders the phase strip inside the pinned-top target once the collab is terminal", () => {
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-done",
          status: "completed",
          phase: "synthesis",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1"),
        },
      ];
      renderPage();
      const pinned = document.querySelectorAll(
        ".collab-pinned-top-target .collab-phase-strip",
      );
      const allStrips = document.querySelectorAll(".collab-phase-strip");
      expect(pinned).toHaveLength(1);
      expect(allStrips).toHaveLength(1);
    });

    it("does not render the terminal final answer twice after transcript writeback", () => {
      const finalAnswer = makeFinalAnswer({
        answer: "Unique collaboration final answer",
      });
      testMessages = [
        {
          role: "user",
          content: [{ type: "text", text: "/collab settle the design" }],
          timestamp: "2024-06-15T10:01:00Z",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: finalAnswer.answer }],
          timestamp: "2024-06-15T10:02:00Z",
        },
      ];
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-done",
          status: "completed",
          phase: "asymmetric_completed_final",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1", {
            artifacts: [finalAnswer],
          }),
        },
      ];

      renderPage();

      expect(
        screen.getAllByText("Unique collaboration final answer"),
      ).toHaveLength(1);
    });

    it("does not render the terminal final answer twice when the /collab trigger is parsed as a command block", () => {
      const finalAnswer = makeFinalAnswer({
        answer: "Unique collaboration final answer from command block",
      });
      testMessages = [
        {
          role: "user",
          content: [
            {
              type: "command",
              name: "/collab",
              args: "settle the design",
            },
          ],
          timestamp: "2024-06-15T10:01:00Z",
        },
        {
          role: "assistant",
          content: [{ type: "text", text: finalAnswer.answer }],
          timestamp: "2024-06-15T10:02:00Z",
        },
      ];
      testCollaborationEnvelopes = [
        {
          workflowId: "wf-done",
          status: "completed",
          phase: "asymmetric_completed_final",
          featureSnapshot: makeCollabFeatureSnapshot("conv-1", {
            artifacts: [finalAnswer],
          }),
        },
      ];

      renderPage();

      expect(
        screen.getAllByText(
          "Unique collaboration final answer from command block",
        ),
      ).toHaveLength(1);
    });
  });

  describe("Codex conversation initial model", () => {
    // Regression: when the active conversation's backend is "codex" and the
    // session query is already in cache (e.g. navigating between conversations),
    // both `selectedBackend` and `selectedModel` initialize together. Previously
    // the model defaulted to the Claude `defaultModel`, so the first prompt
    // was sent as "opus" against the Codex backend and the API rejected it.
    it("submits a Codex model (not the Claude defaultModel) on first prompt", async () => {
      testSession = {
        ...baseSession,
        conversations: [
          {
            ...baseSession.conversations[0]!,
            agentBackend: "codex",
          },
        ],
      };

      renderPage(); // defaultModel="sonnet" (a Claude model)

      const textarea = screen.getByPlaceholderText(
        "Send a prompt to Claude...",
      );
      fireEvent.change(textarea, { target: { value: "Hello" } });

      const sendBtn = screen.getAllByTitle("Send prompt")[0]!;
      fireEvent.click(sendBtn);

      expect(sendPromptMock).toHaveBeenCalledTimes(1);
      const callArgs = sendPromptMock.mock.calls[0]!;
      const submittedModel = callArgs[2] as string;
      const submittedBackend = callArgs[5] as string;

      expect(submittedBackend).toBe("codex");
      // Must NOT be the Claude defaultModel — that's the bug.
      expect(submittedModel).not.toBe("sonnet");
      expect(submittedModel).not.toBe("opus");
      expect(submittedModel).not.toBe("haiku");
    });
  });
});
