import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useRef, type ReactNode } from "react";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import ConversationVirtuosoList, {
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import {
  buildConversationRows,
  type ConversationRow,
} from "@/features/session/conversation/conversation-rows";

const meta = {
  title: "Projects/ConversationVirtuosoList",
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

function textMessage(
  role: "user" | "assistant",
  text: string,
  timestamp: string,
): TranscriptMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp,
  };
}

const mixedMessages: TranscriptMessage[] = [
  textMessage(
    "user",
    "Can you inspect the failed build?",
    "2024-06-15T10:00:00Z",
  ),
  textMessage(
    "assistant",
    "The failure is in the session detail page typecheck. I am narrowing it to the scroll state changes.",
    "2024-06-15T10:01:00Z",
  ),
  textMessage(
    "user",
    "Keep the existing navigation behavior.",
    "2024-06-15T10:02:00Z",
  ),
  textMessage(
    "assistant",
    "Navigation remains message-index based while Virtuoso owns row measurement and scrolling.",
    "2024-06-15T10:03:00Z",
  ),
];

function renderMessage({
  row,
}: {
  row: Extract<ConversationRow, { kind: "message" }>;
  isLast: boolean;
}) {
  const isUser = row.msg.role === "user";
  const text =
    row.msg.content.find(
      (block): block is { type: "text"; text: string } => block.type === "text",
    )?.text ?? "";
  return (
    <div
      className={`message ${row.msg.role}`}
      data-msg-index={row.messageIndex}
    >
      <div className="message-role">{isUser ? "You" : "Claude"}</div>
      <div className="message-content">{text}</div>
    </div>
  );
}

function renderCollab() {
  return (
    <div data-collab-row="true" className="collab-passage">
      <div className="collab-passage-header">
        <div>
          <div className="collab-passage-title">Collaboration</div>
          <div className="collab-passage-subtitle">
            Cross-review in progress
          </div>
        </div>
      </div>
    </div>
  );
}

function renderFooter() {
  return null;
}

function renderStreamingFooter() {
  return (
    <div className="message assistant typing-indicator">
      <div className="message-role">Claude</div>
      <div className="message-content">
        <div className="typing-dots">
          <span />
          <span />
          <span />
        </div>
      </div>
    </div>
  );
}

function StoryFrame({
  rows,
  footer = renderFooter,
}: {
  rows: ConversationRow[];
  footer?: () => ReactNode;
}) {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  return (
    <div className="prompt-panel" style={{ height: "100vh" }}>
      <div className="panel-body">
        <div className="conversation" data-backend="claude">
          {rows.length === 0 ? (
            <div
              className="empty-state"
              style={{ padding: "var(--space-xl) 0" }}
            >
              <div className="empty-state-title">No messages yet</div>
              <div className="empty-state-desc">
                Send a prompt to start the conversation.
              </div>
            </div>
          ) : (
            <ConversationVirtuosoList
              rows={rows}
              virtuosoRef={virtuosoRef}
              conversationId="storybook-conversation"
              renderMessage={renderMessage}
              renderCollab={renderCollab}
              renderFooter={footer}
              onRangeChanged={() => {}}
              onAtBottomStateChange={() => {}}
              onAtTopStateChange={() => {}}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export const Empty: Story = {
  render: () => <StoryFrame rows={[]} />,
};

export const SingleShortMessage: Story = {
  render: () => (
    <StoryFrame
      rows={buildConversationRows(
        [textMessage("user", "Hello", "2024-06-15T10:00:00Z")],
        undefined,
      )}
    />
  ),
};

export const MixedTranscript: Story = {
  render: () => (
    <StoryFrame rows={buildConversationRows(mixedMessages, undefined)} />
  ),
};

export const WithCollabRow: Story = {
  render: () => (
    <StoryFrame
      rows={buildConversationRows(
        [
          textMessage(
            "user",
            "/collab compare both approaches",
            "2024-06-15T10:00:00Z",
          ),
          textMessage(
            "assistant",
            "I started the collaboration.",
            "2024-06-15T10:01:00Z",
          ),
        ],
        { workflowId: "storybook-wf" },
      )}
    />
  ),
};

export const WithStreamingTail: Story = {
  render: () => (
    <StoryFrame
      rows={buildConversationRows(mixedMessages, undefined)}
      footer={renderStreamingFooter}
    />
  ),
};

export const VeryLongTranscript: Story = {
  render: () => (
    <StoryFrame
      rows={buildConversationRows(
        Array.from({ length: 200 }, (_, i) =>
          textMessage(
            i % 2 === 0 ? "user" : "assistant",
            `Message ${i + 1}: ${"This transcript row has enough text to exercise dynamic row measurement. ".repeat((i % 5) + 1)}`,
            `2024-06-15T10:${String(i).padStart(2, "0")}:00Z`,
          ),
        ),
        undefined,
      )}
    />
  ),
};
