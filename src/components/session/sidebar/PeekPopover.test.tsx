// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import { useCollaborationStore } from "@/stores/collaboration.store";
import PeekPopover from "@/components/session/sidebar/PeekPopover";
import type { ApprovalScopedChanges } from "@/components/ApprovalGatePanel";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const BASE_CONVERSATION: SessionActiveConversation = {
  scope: "session",
  id: "convo-1",
  name: "Schema and deps foundation",
  status: "running",
  lastActivityAt: "2026-05-15T12:30:00.000Z",
  projectName: "command-center",
  projectPath: "/Users/alex/github/command-center",
  sessionName: "peek-replay",
  agentBackend: "codex",
  summary: "Building the peek popover.",
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  branchName: "schema-and-deps-foundation",
  worktreePath:
    "/Users/alex/github/command-center/.worktrees/peek-replay-02e449.schema-and-deps-foundation",
  lastActivitySummary: "Reading the popover spec.",
  unread: false,
  pendingApproval: null,
  backgroundActivity: null,
};

const TRANSCRIPT_MESSAGES: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Please build the popover." }],
    timestamp: "2026-05-15T12:28:00.000Z",
  },
  {
    role: "assistant",
    content: [{ type: "text", text: "I am wiring the component now." }],
    timestamp: "2026-05-15T12:29:00.000Z",
  },
  {
    role: "user",
    content: [{ type: "text", text: "Add the nav controls too." }],
    timestamp: "2026-05-15T12:29:30.000Z",
  },
];

const BACKEND_DEFAULTS: BackendSelectionDefaultsById = {
  claude: { modelId: "opus", effort: "high" },
  codex: { modelId: "gpt-5.4", effort: "high", codexFastMode: false },
  cursor: { modelId: "composer-2.5", effort: "high" },
};

function renderPeek(
  overrides: Partial<React.ComponentProps<typeof PeekPopover>> = {},
  /** Wraps the popover — the profile picker inside it reads React Query. */
  wrap: (ui: React.ReactElement) => React.ReactElement = (ui) => ui,
) {
  const anchorEl = document.createElement("button");
  anchorEl.textContent = "anchor";
  document.body.appendChild(anchorEl);

  const props: React.ComponentProps<typeof PeekPopover> = {
    anchorEl,
    conversation: BASE_CONVERSATION,
    transcriptMessages: TRANSCRIPT_MESSAGES,
    backendDefaults: BACKEND_DEFAULTS,
    onClose: vi.fn(),
    onOpenFull: vi.fn(),
    onReplyText: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onFork: vi.fn(),
    forkProjectName: "remote-ai-manager",
    ...overrides,
  };

  return {
    ...render(wrap(<PeekPopover {...props} />)),
    props,
    anchorEl,
  };
}

describe("PeekPopover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:42:00.000Z"));
    useCollaborationStore.setState({ collabConfigDraftsByConversation: {} });
    if (typeof Range !== "undefined") {
      if (!Range.prototype.getClientRects) {
        Range.prototype.getClientRects = () =>
          ({
            length: 0,
            item: () => null,
            [Symbol.iterator]: function* () {},
          }) as unknown as DOMRectList;
      }
      if (!Range.prototype.getBoundingClientRect) {
        Range.prototype.getBoundingClientRect = () =>
          ({
            x: 0,
            y: 0,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            width: 0,
            height: 0,
            toJSON: () => ({}),
          }) as DOMRect;
      }
    }
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => document.querySelector(".ProseMirror") ?? document.body,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    useCollaborationStore.setState({ collabConfigDraftsByConversation: {} });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    document.body.innerHTML = "";
  });

  it("renders the fallback waiting-for-input banner only when there are no structured questions", () => {
    renderPeek({
      conversation: {
        ...BASE_CONVERSATION,
        status: "waiting_for_input",
        pendingQuestion: "Should I continue with the current approach?",
        pendingQuestionId: null,
        pendingQuestions: null,
      },
    });

    expect(
      screen.getByText("Should I continue with the current approach?"),
    ).toBeDefined();
    expect(screen.getByText("Please build the popover.")).toBeDefined();
  });

  it("sends free-text replies without closing the popover and clears the editor", async () => {
    const onReplyText = vi.fn();
    const onClose = vi.fn();
    vi.useRealTimers();
    const user = userEvent.setup();

    renderPeek({ onReplyText, onClose });

    const editor = screen.getByLabelText("Reply text");
    await user.click(editor);
    await user.keyboard("Status?");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onReplyText).toHaveBeenCalledWith("Status?", []);
    expect(onClose).not.toHaveBeenCalled();
    expect(editor).toHaveTextContent("");
  });

  it("enables and sends a conversation-reference-only reply", async () => {
    vi.useRealTimers();
    const onReplyText = vi.fn();
    renderPeek({ onReplyText });
    const reference =
      '<conversation-ref project-name="my-app" project-path="/repos/my-app" ' +
      'scope="session" ' +
      'session-name="main" worktree-path="/repos/my-app/.worktrees/main" ' +
      'conversation-id="conv-2" conversation-name="Refactor parser" ' +
      'backend="claude" backend-ref="sess-abc" debug-log-path="" ' +
      'status="running" last-activity-at="2026-06-01T12:00:00Z" ' +
      'compact-status="none" read-command="cctl conversation read conv-2 --outline" />';
    const editor = document.querySelector(".ProseMirror") as HTMLElement;

    fireEvent.paste(editor, {
      clipboardData: {
        items: [],
        files: [],
        types: ["text/plain"],
        getData: (type: string) => (type === "text/plain" ? reference : ""),
      },
    });

    const send = screen.getByRole("button", { name: "Send" });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onReplyText).toHaveBeenCalledWith(reference, []);
  });

  it("shows a sending state on the reply button while the reply is in flight", () => {
    renderPeek({ isSendingReply: true });

    const sendButton = screen.getByRole("button", { name: /sending/i });
    expect(sendButton).toBeDisabled();
    expect(sendButton.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByLabelText("Reply text")).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("uses the shared Tiptap prompt editor for free-text replies", () => {
    renderPeek();

    const editor = screen.getByLabelText("Reply text");
    expect(editor).toHaveAttribute("contenteditable", "true");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("shows and submits Agent Two controls for /collab replies", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onReplyText = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderPeek({ onReplyText }, (ui) => (
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    ));

    const editor = screen.getByLabelText("Reply text");
    await user.click(editor);
    await user.keyboard("/collab compare the approaches");

    const controls = screen.getByRole("region", {
      name: "Collaboration configuration",
    });
    expect(within(controls).getByText("2nd agent")).toBeInTheDocument();
    expect(
      within(controls).getByTestId("model-selector-trigger"),
    ).toHaveTextContent("Opus");
    expect(within(controls).getByTitle(/^Effort:/)).toHaveTextContent("High");

    await user.click(within(controls).getByTestId("model-selector-trigger"));
    expect(screen.getByRole("listbox")).toHaveClass("z-popover");
    expect(screen.getByRole("listbox")).not.toHaveClass("z-menu");
    await user.keyboard("{Escape}");

    await user.click(within(controls).getByTitle(/^Effort:/));
    expect(screen.getByRole("listbox")).toHaveClass("z-popover");
    await user.keyboard("{Escape}");

    await user.click(
      within(controls).getByRole("combobox", {
        name: "Agent profile",
      }),
    );
    expect(screen.getByRole("listbox")).toHaveClass("z-popover");
    await user.keyboard("{Escape}");

    await user.click(within(controls).getByRole("button", { name: "Codex" }));
    expect(within(controls).getByLabelText("Codex speed")).toBeInTheDocument();
    await user.click(within(controls).getByRole("radio", { name: "Fast" }));
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onReplyText).toHaveBeenCalledWith(
      "/collab compare the approaches",
      [],
      {
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        agentTwo: {
          backend: "codex",
          model: "gpt-5.4",
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      {
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
        agentTwo: {
          backend: "codex",
          model: "gpt-5.4",
          effort: "high",
          fastMode: true,
        },
      },
    );
  });

  it("dismisses /collab without discarding the reply brief", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onReplyText = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderPeek({ onReplyText }, (ui) => (
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    ));

    const editor = screen.getByLabelText("Reply text");
    await user.click(editor);
    await user.keyboard("/collab compare the approaches");
    await user.click(screen.getByRole("button", { name: "Dismiss /collab" }));

    expect(
      screen.queryByRole("region", { name: "Collaboration configuration" }),
    ).toBeNull();
    expect(editor).toHaveTextContent("compare the approaches");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(onReplyText).toHaveBeenCalledWith("compare the approaches", []);
  });

  it("does not dispatch /collab without a brief", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const onReplyText = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    renderPeek({ onReplyText }, (ui) => (
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    ));

    const editor = screen.getByLabelText("Reply text");
    await user.click(editor);
    await user.keyboard("/collab");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(onReplyText).not.toHaveBeenCalled();
    expect(editor).toHaveTextContent("/collab");
  });

  it("shows the voice tool when voice recording is available", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          available: true,
        }),
      ),
    );

    renderPeek();

    expect(await screen.findByTitle("Voice input")).toBeInTheDocument();
  });

  it("starts voice recording from the voice control inside the popover", async () => {
    vi.useRealTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          available: true,
        }),
      ),
    );
    const getUserMedia = vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
    }));
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });
    class FakeMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      readonly state = "inactive";
      readonly mimeType = "audio/webm";

      start() {}
      stop() {}
    }
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);

    const user = userEvent.setup();
    renderPeek();

    const editor = screen.getByLabelText("Reply text");
    const voiceButton = await screen.findByTitle("Voice input");
    await user.click(editor);
    await user.click(voiceButton);

    await waitFor(() => {
      expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
  });

  it("does not render any pre-filled quick-reply chips", () => {
    renderPeek({ conversation: { ...BASE_CONVERSATION, status: "awaiting" } });
    expect(screen.queryByText("Continue")).toBeNull();
    expect(screen.queryByText("Summarize")).toBeNull();
    expect(screen.queryByText("Next task")).toBeNull();
  });

  it("reuses AskQuestionPanel for structured pending questions", () => {
    renderPeek({
      conversation: {
        ...BASE_CONVERSATION,
        status: "waiting_for_input",
        pendingQuestion: "Which path should I take?",
        pendingQuestionId: "question-1",
        pendingQuestions: [
          {
            question: "Which path should I take?",
            options: [
              { label: "A", recommended: false },
              { label: "B", recommended: false },
              { label: "C", recommended: false },
            ],
            multiSelect: false,
            required: true,
            allowNote: true,
          },
        ],
      },
    });

    expect(screen.getByText("Which path should I take?")).toBeDefined();
    expect(screen.getByText("Needs your input")).toBeDefined();
    expect(screen.queryByText("Yes, proceed")).toBeNull();
  });

  it("submits structured pending-question answers through the peek answer handler", () => {
    const onAnswerQuestion = vi.fn();

    renderPeek({
      onAnswerQuestion,
      conversation: {
        ...BASE_CONVERSATION,
        status: "waiting_for_input",
        pendingQuestion: "Which path should I take?",
        pendingQuestionId: "question-1",
        pendingQuestions: [
          {
            question: "Which path should I take?",
            options: [
              { label: "A", recommended: false },
              { label: "B", recommended: false },
            ],
            multiSelect: false,
            required: true,
            allowNote: true,
          },
        ],
      },
    });

    fireEvent.click(screen.getByText("A"));
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));

    // No id on the fixture question → server-style index fallback key "0".
    expect(onAnswerQuestion).toHaveBeenCalledWith({
      "0": {
        selected: ["A"],
        note: null,
        skipped: false,
        question: "Which path should I take?",
      },
    });
  });

  it("closes from Escape and backdrop clicks but not panel clicks", () => {
    const onClose = vi.fn();
    renderPeek({ onClose });

    fireEvent.click(screen.getByLabelText("Conversation peek"));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    const backdrop = document.querySelector(".peek-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  describe("auto-scroll", () => {
    const scrollTopValues = new WeakMap<Element, number>();
    let originalScrollHeight: PropertyDescriptor | undefined;
    let originalScrollTop: PropertyDescriptor | undefined;

    beforeEach(() => {
      originalScrollHeight = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollHeight",
      );
      originalScrollTop = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollTop",
      );
      Object.defineProperty(Element.prototype, "scrollHeight", {
        configurable: true,
        get() {
          return 2000;
        },
      });
      Object.defineProperty(Element.prototype, "scrollTop", {
        configurable: true,
        set(this: Element, value: number) {
          scrollTopValues.set(this, value);
        },
        get(this: Element) {
          return scrollTopValues.get(this) ?? 0;
        },
      });
    });

    afterEach(() => {
      if (originalScrollHeight) {
        Object.defineProperty(
          Element.prototype,
          "scrollHeight",
          originalScrollHeight,
        );
      }
      if (originalScrollTop) {
        Object.defineProperty(
          Element.prototype,
          "scrollTop",
          originalScrollTop,
        );
      }
    });

    it("scrolls the body to the bottom on mount so the last message is visible", () => {
      renderPeek();
      const body = document.querySelector(
        '[data-testid="peek-body"]',
      ) as HTMLElement;
      expect(body).not.toBeNull();
      expect(body.scrollTop).toBe(2000);
    });
  });

  describe("approval gate", () => {
    const GATED_CONVERSATION: SessionActiveConversation = {
      ...BASE_CONVERSATION,
      status: "awaiting",
      role: "iteration",
      pendingApproval: {
        contextId: "context-implement",
        contextTitle: "Implement",
        requestedAt: "2026-05-15T12:00:00.000Z",
        workflowName: null,
        executionSuspended: false,
        enveloped: false,
        tasksCompleted: 6,
        tasksTotal: 6,
      },
    };

    function gateProps(
      overrides: Partial<
        NonNullable<React.ComponentProps<typeof PeekPopover>["approvalGate"]>
      > = {},
    ) {
      return {
        isSubmitting: false,
        executionSuspended: false,
        // A resolved candidate is the minimum every parked gate carries; the
        // peek offers live Approve/Reject, so it never renders one without.
        scopedChanges: {
          status: "ready",
          candidate: { scope: "whole_tree" },
        } satisfies ApprovalScopedChanges,
        onApprove: vi.fn(),
        onReject: vi.fn(),
        ...overrides,
      };
    }

    // The peek is a real approval surface with live Approve/Reject controls, so
    // an enveloped context has to be decided on here through the same frozen
    // owned-path artifact the workspace panel renders (R15.2) — never through
    // the shared lane worktree's whole-tree delta, and never through nothing.
    it("renders the frozen owned-path artifact for an enveloped context", () => {
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps({
          scopedChanges: {
            status: "ready",
            candidate: {
              scope: "owned",
              ownedPaths: ["src/api"],
              diff: {
                files: [
                  {
                    filePath: "src/api/handler.ts",
                    additions: 1,
                    deletions: 0,
                    hunks: [
                      {
                        header: "@@ -1 +1,2 @@",
                        lines: [
                          { type: "hunk-header", content: "@@ -1 +1,2 @@" },
                          {
                            type: "add",
                            content: "export const handler = 2;",
                          },
                        ],
                      },
                    ],
                  },
                ],
                totalAdditions: 1,
                totalDeletions: 0,
              },
            },
          },
        }),
      });

      expect(
        screen.getByTestId("approval-gate-scoped-changes"),
      ).toHaveTextContent("src/api/handler.ts");
      expect(screen.getByTestId("approval-candidate-state")).toHaveTextContent(
        "1 file · +1 −0 · scoped to src/api",
      );
    });

    it("does not offer Approve in the peek before the frozen artifact loads", () => {
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps({ scopedChanges: { status: "loading" } }),
      });

      expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    });

    it("shows the awaiting-approval header status with elapsed time", () => {
      renderPeek({
        conversation: {
          ...GATED_CONVERSATION,
          pendingApproval: {
            ...GATED_CONVERSATION.pendingApproval!,
            requestedAt: new Date(Date.now() - 4 * 60_000).toISOString(),
          },
        },
        approvalGate: gateProps(),
      });

      expect(screen.getByText("awaiting approval · 4m")).toBeInTheDocument();
    });

    it("renders the approval panel above the live reply composer for a gated conversation", () => {
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps(),
      });

      const panel = screen.getByTestId("approval-gate-panel");
      expect(panel).toBeInTheDocument();
      expect(
        screen.getByText("Context approval — Implement"),
      ).toBeInTheDocument();
      const editor = screen.getByLabelText("Reply text");
      expect(editor).toBeInTheDocument();
      expect(
        panel.compareDocumentPosition(editor) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("renders the approval panel above structured pending questions", () => {
      renderPeek({
        conversation: {
          ...GATED_CONVERSATION,
          status: "waiting_for_input",
          pendingQuestionId: "question-1",
          pendingQuestions: [
            {
              question: "Which path should I take?",
              options: [
                { label: "A", recommended: false },
                { label: "B", recommended: false },
              ],
              multiSelect: false,
              required: true,
              allowNote: true,
            },
          ],
        },
        approvalGate: gateProps(),
      });

      const panel = screen.getByTestId("approval-gate-panel");
      const question = screen.getByText("Which path should I take?");
      expect(
        panel.compareDocumentPosition(question) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("invokes the approve callback", () => {
      const onApprove = vi.fn();
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps({ onApprove }),
      });

      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      expect(onApprove).toHaveBeenCalledTimes(1);
    });

    it("invokes the reject callback with the message", () => {
      const onReject = vi.fn();
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps({ onReject }),
      });

      fireEvent.change(
        screen.getByPlaceholderText(
          "Required to reject — returned to the implementer",
        ),
        { target: { value: "needs more tests" } },
      );
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
      expect(onReject).toHaveBeenCalledWith("needs more tests");
    });

    it("disables decisions while the conversation has a turn in flight", () => {
      renderPeek({
        conversation: { ...GATED_CONVERSATION, status: "running" },
        approvalGate: gateProps(),
      });

      expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
      expect(screen.getByText(/Chat turn in progress/)).toBeInTheDocument();
    });

    it("shows the suspended hint when the execution is paused or halted", () => {
      renderPeek({
        conversation: GATED_CONVERSATION,
        approvalGate: gateProps({ executionSuspended: true }),
      });

      expect(screen.getByText(/Execution suspended/)).toBeInTheDocument();
    });

    it("renders no panel once the pending approval clears", () => {
      renderPeek({
        conversation: { ...GATED_CONVERSATION, pendingApproval: null },
        approvalGate: null,
      });

      expect(screen.queryByTestId("approval-gate-panel")).toBeNull();
      expect(screen.getByLabelText("Reply text")).toBeInTheDocument();
    });
  });

  describe("fork", () => {
    it("invokes onFork with the message index when fork button is clicked", () => {
      const onFork = vi.fn();
      renderPeek({ onFork });

      const forkButtons = screen.getAllByTitle(
        "Fork conversation from this message",
      );
      expect(forkButtons.length).toBe(TRANSCRIPT_MESSAGES.length);

      fireEvent.click(forkButtons[1]!);
      expect(onFork).toHaveBeenCalledWith(1, undefined);
    });

    // R7.1: the peek renders the conversation's real transcript indices, so its
    // index-0 fork is the same fresh conversation the full transcript's is and
    // gets the same profile selection.
    it("offers a Standard-Agent-defaulted picker on the index-0 fork", async () => {
      // The picker's Radix listbox and React Query both settle on timers the
      // rest of this suite freezes to pin relative timestamps.
      vi.useRealTimers();
      const onFork = vi.fn();
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      renderPeek({ onFork }, (ui) => (
        <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
      ));

      fireEvent.click(
        screen.getAllByTitle("Fork conversation from this message")[0]!,
      );
      expect(
        await screen.findByRole("combobox", { name: /agent profile/i }),
      ).toHaveTextContent("Standard Agent");
      expect(onFork).not.toHaveBeenCalled();

      fireEvent.click(
        screen.getByRole("button", { name: "Fork conversation" }),
      );
      expect(onFork).toHaveBeenCalledWith(0, {
        tier: "builtin",
        id: "standard-agent",
      });
    });
  });
});
