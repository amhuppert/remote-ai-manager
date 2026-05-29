// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { ActiveConversation } from "@/lib/active-conversations/schemas";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import PeekPopover from "@/features/session/sidebar/PeekPopover";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const BASE_CONVERSATION: ActiveConversation = {
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

function renderPeek(
  overrides: Partial<React.ComponentProps<typeof PeekPopover>> = {},
) {
  const anchorEl = document.createElement("button");
  anchorEl.textContent = "anchor";
  document.body.appendChild(anchorEl);

  const props: React.ComponentProps<typeof PeekPopover> = {
    anchorEl,
    conversation: BASE_CONVERSATION,
    transcriptMessages: TRANSCRIPT_MESSAGES,
    onClose: vi.fn(),
    onOpenFull: vi.fn(),
    onReplyText: vi.fn(),
    onAnswerQuestion: vi.fn(),
    onFork: vi.fn(),
    ...overrides,
  };

  return {
    ...render(<PeekPopover {...props} />),
    props,
    anchorEl,
  };
}

describe("PeekPopover", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:42:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("sends free-text replies without closing the popover and clears the textarea", async () => {
    const onReplyText = vi.fn();
    const onClose = vi.fn();

    renderPeek({ onReplyText, onClose });

    const textarea = screen.getByLabelText("Reply text");
    fireEvent.change(textarea, { target: { value: "Status?" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onReplyText).toHaveBeenCalledWith("Status?");
    expect(onClose).not.toHaveBeenCalled();
    expect(textarea).toHaveValue("");
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
            options: [{ label: "A" }, { label: "B" }, { label: "C" }],
            multiSelect: false,
          },
        ],
      },
    });

    expect(screen.getByText("Agent needs your input")).toBeDefined();
    expect(screen.queryByText("Yes, proceed")).toBeNull();
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
      const body = document.querySelector(".peek__body") as HTMLElement;
      expect(body).not.toBeNull();
      expect(body.scrollTop).toBe(2000);
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
      expect(onFork).toHaveBeenCalledWith(1);
    });
  });
});
