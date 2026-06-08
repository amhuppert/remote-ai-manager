// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithQuery } from "@/test/component-mocks";
import MessageRow from "@/components/conversation/MessageRow";
import type {
  ConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";

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
  return {
    id: "conv-1",
    name: null,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 1,
    createdAt: "2024-01-01T00:00:00Z",
    lastActivityAt: "2024-01-01T00:00:00Z",
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
    machineSnapshot: null,
    agentBackend: "claude",
    backendRef: null,
    unread: false,
    pendingQueue: [],
    ...overrides,
  };
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

  it("renders the model name in meta for assistant messages with a model field", () => {
    renderWithQuery(
      <MessageRow
        msg={makeMessage({ role: "assistant", model: "sonnet" })}
        messageIndex={1}
        isLast={false}
        selectedBackend="claude"
        worktreePath="/tmp/proj"
        onFork={vi.fn()}
        lastMessageExtras={null}
      />,
    );
    expect(screen.getByText("sonnet")).toBeInTheDocument();
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
