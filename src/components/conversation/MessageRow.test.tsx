// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import MessageRow from "@/components/conversation/MessageRow";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";

function makeMessage(
  overrides: Partial<TranscriptMessage> = {},
): TranscriptMessage {
  return {
    role: "user",
    content: [{ type: "text", text: "Hello there" }],
    timestamp: "2024-06-15T10:01:00Z",
    ...overrides,
  };
}

function makeConversation(
  overrides: Partial<ConversationState> = {},
): ConversationState {
  return makeConversationState({
    profileSnapshot: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
    debugMode: {
      active: true,
      recording: true,
      logFilePath: "/tmp/debug.jsonl",
      enteredAt: "2024-01-01T00:00:00Z",
      hypotheses: [],
      reproductionSteps: [],
      instructionsDelivered: true,
      phase: "awaiting_reproduction",
      fixSummary: null,
      verificationSteps: [],
      lastTurnFailed: false,
    },
    ...overrides,
  });
}

describe("MessageRow", () => {
  it("renders 'You' as the role for user messages", () => {
    renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "user" })}
        messageIndex={0}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("renders 'Claude' for assistant role when selectedBackend='claude'", () => {
    renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "assistant" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(screen.getByText("Claude")).toBeInTheDocument();
  });

  it("renders 'Codex' for assistant role when selectedBackend='codex'", () => {
    renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "assistant" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="codex"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("renders the complete model selection in assistant metadata", () => {
    renderWithQuery(
      <MessageRow
        msg={makeMessage({
          role: "assistant",
          modelSelection: {
            modelId: "composer-2.5",
            parameters: {
              thinking: "true",
              context: "1m",
              reasoning: "xhigh",
              fast: "false",
            },
          },
        })}
        messageIndex={1}
        isLast={false}
        selectedBackend="cursor"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(screen.getByText("composer-2.5")).toBeInTheDocument();
    expect(screen.getByText("context=1m")).toBeInTheDocument();
    expect(screen.getByText("fast=false")).toBeInTheDocument();
    expect(screen.getByText("reasoning=xhigh")).toBeInTheDocument();
    expect(screen.getByText("thinking=true")).toBeInTheDocument();
  });

  // The rendered clock text is zone-dependent, so these assert the structure
  // and machine-readable value; the exact formatting is pinned by
  // format-local-time.test.ts.
  describe("timestamp", () => {
    it.each(["user", "assistant", "notice"] as const)(
      "renders the local time in the label row of a %s message",
      (role) => {
        const { container } = renderWithQuery(
          <MessageRow
            msg={makeMessage({ role, timestamp: "2024-06-15T10:01:00Z" })}
            messageIndex={0}
            isLast={false}
            selectedBackend="claude"
            worktreePath="/tmp/proj"
            lastMessageExtras={null}
          />,
        );
        const time = container.querySelector("time");
        expect(time).not.toBeNull();
        expect(time?.getAttribute("datetime")).toBe("2024-06-15T10:01:00Z");
        expect(time?.textContent).toMatch(/\d{1,2}:\d{2}/);
      },
    );

    it("omits the timestamp when the message has none", () => {
      const { container } = renderWithQuery(
        <MessageRow
          msg={makeMessage({ role: "user", timestamp: null })}
          messageIndex={0}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          lastMessageExtras={null}
        />,
      );
      expect(container.querySelector("time")).toBeNull();
    });
  });

  it("always renders the copy action, and shows the fork action only when onFork is provided", () => {
    const withFork = renderWithQuery(
      <MessageRow
        msg={makeMessage({
          role: "assistant",
          modelSelection: { modelId: "sonnet", parameters: {} },
        })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(
      withFork.container.querySelector('[title="Copy message as Markdown"]'),
    ).not.toBeNull();
    expect(
      withFork.container.querySelector(
        '[title="Fork conversation from this message"]',
      ),
    ).not.toBeNull();

    const noFork = renderWithQuery(
      <MessageRow
        msg={makeMessage({
          role: "assistant",
          modelSelection: { modelId: "sonnet", parameters: {} },
        })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        lastMessageExtras={null}
      />,
    );
    // Copy is always available; fork is hidden when no handler is wired.
    expect(
      noFork.container.querySelector('[title="Copy message as Markdown"]'),
    ).not.toBeNull();
    expect(
      noFork.container.querySelector(
        '[title="Fork conversation from this message"]',
      ),
    ).toBeNull();
  });

  it("offers Copy-reference only for transcript rows with conversation identity", () => {
    const compactionTarget = {
      scope: "session",
      projectName: "proj",
      sessionName: "sess",
      conversationId: "conv-1",
    } as const;

    const transcriptRow = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "user" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        compactionTarget={compactionTarget}
        lastMessageExtras={null}
      />,
    );
    expect(
      transcriptRow.container.querySelector('[title="Copy message reference"]'),
    ).not.toBeNull();

    // Queued rows render at a provisional index → no reference to copy.
    const queuedRow = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "user" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        compactionTarget={compactionTarget}
        queuedMetadata={null}
        lastMessageExtras={null}
      />,
    );
    expect(
      queuedRow.container.querySelector('[title="Copy message reference"]'),
    ).toBeNull();

    const noIdentity = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "user" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        lastMessageExtras={null}
      />,
    );
    expect(
      noIdentity.container.querySelector('[title="Copy message reference"]'),
    ).toBeNull();
  });

  it("renders DebugActionCard for the last assistant message when lastMessageExtras is supplied", () => {
    const { container } = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "assistant" })}
        messageIndex={2}
        isLast={true}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={{
          projectName: "proj",
          sessionName: "sess",
          conversation: makeConversation(),
          onSendPrompt: vi.fn().mockResolvedValue(undefined),
          isBusy: false,
        }}
      />,
    );
    expect(container.querySelector(".debug-action-card")).not.toBeNull();
    expect(
      screen.getByRole("button", { name: "Exit Debug" }),
    ).toBeInTheDocument();
  });

  it("does not render DebugActionCard when isLast=false even if extras are present", () => {
    const { container } = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "assistant" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={{
          projectName: "proj",
          sessionName: "sess",
          conversation: makeConversation(),
          onSendPrompt: vi.fn().mockResolvedValue(undefined),
          isBusy: false,
        }}
      />,
    );
    expect(container.querySelector(".debug-action-card")).toBeNull();
  });

  describe("notice messages", () => {
    it("renders a notice as a distinct system row with its content", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "notice",
            content: [{ type: "text", text: "Commit job started." }],
          })}
          messageIndex={1}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.getByText("System")).toBeInTheDocument();
      expect(screen.getByText("Commit job started.")).toBeInTheDocument();
    });

    it("does not label a notice as You/Claude/Codex", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "notice",
            content: [{ type: "text", text: "Merge rejected: session busy" }],
          })}
          messageIndex={1}
          isLast={false}
          selectedBackend="codex"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.queryByText("You")).toBeNull();
      expect(screen.queryByText("Claude")).toBeNull();
      expect(screen.queryByText("Codex")).toBeNull();
    });

    it("does not offer the fork action on a notice row even when onFork is wired", () => {
      const { container } = renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "notice",
            content: [{ type: "text", text: "Commit job started." }],
          })}
          messageIndex={1}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(
        container.querySelector(
          '[title="Fork conversation from this message"]',
        ),
      ).toBeNull();
    });

    it("does not render DebugActionCard for a last notice message", () => {
      const { container } = renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "notice",
            content: [{ type: "text", text: "Commit job started." }],
          })}
          messageIndex={2}
          isLast={true}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={{
            projectName: "proj",
            sessionName: "sess",
            conversation: makeConversation(),
            onSendPrompt: vi.fn().mockResolvedValue(undefined),
            isBusy: false,
          }}
        />,
      );
      expect(container.querySelector(".debug-action-card")).toBeNull();
    });
  });

  describe("workflow iteration badge", () => {
    it("renders the iteration index when origin.source === 'workflow'", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "assistant",
            origin: {
              source: "workflow",
              workflow: {
                executionId: "exec-1",
                nodeId: "ctx-impl",
                iterationIndex: 3,
              },
            },
          })}
          messageIndex={5}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.getByText("iter 3")).toBeInTheDocument();
    });

    it("does not render the badge when origin is absent (legacy turn)", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({ role: "assistant" })}
          messageIndex={1}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.queryByText(/^iter /)).toBeNull();
    });

    it("does not render the badge when origin.source === 'user'", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "user",
            origin: { source: "user" },
          })}
          messageIndex={2}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.queryByText(/^iter /)).toBeNull();
    });

    it("does not render the badge when origin.source === 'workflow' but iterationIndex is missing", () => {
      renderWithQuery(
        <MessageRow
          msg={makeMessage({
            role: "assistant",
            origin: { source: "workflow" },
          })}
          messageIndex={2}
          isLast={false}
          selectedBackend="claude"
          worktreePath="/tmp/proj"
          onFork={vi.fn()}
          lastMessageExtras={null}
        />,
      );
      expect(screen.queryByText(/^iter /)).toBeNull();
    });
  });

  it("does not render DebugActionCard for the last user message", () => {
    const { container } = renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "user" })}
        messageIndex={2}
        isLast={true}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={{
          projectName: "proj",
          sessionName: "sess",
          conversation: makeConversation(),
          onSendPrompt: vi.fn().mockResolvedValue(undefined),
          isBusy: false,
        }}
      />,
    );
    expect(container.querySelector(".debug-action-card")).toBeNull();
  });
});
