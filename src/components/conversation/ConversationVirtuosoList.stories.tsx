import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { useRef, useState, type ReactNode } from "react";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ConversationTranscript, {
  type TranscriptNav,
} from "./ConversationTranscript";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import ConversationVirtuosoList, {
  ConversationVirtuosoItem,
  type VirtuosoHandle,
} from "@/components/conversation/ConversationVirtuosoList";
import {
  buildConversationRows,
  type ConversationRow,
} from "@/components/conversation/conversation-rows";
import { groupContentBlocks } from "@/lib/conversations/group-content-blocks";

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
  // A message contributes one row per renderable unit, so this stand-in draws
  // only its own slice — and only the opening part draws the role label.
  const item = groupContentBlocks(row.msg.content)[row.part.start];
  const text =
    item?.kind === "block" && item.block.type === "text"
      ? item.block.text
      : item?.kind === "tool_group"
        ? `⚙ ${item.blocks.length} tool call(s)`
        : item?.kind === "thinking_group"
          ? "✻ thinking"
          : "";
  return (
    <div
      className={`message ${row.msg.role}`}
      data-msg-index={row.messageIndex}
      data-part-last={String(row.part.index === row.part.count - 1)}
    >
      {row.part.index === 0 && (
        <div className="message-role">{isUser ? "You" : "Claude"}</div>
      )}
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
      <div
        className="panel-body"
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          minHeight: 0,
        }}
      >
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
              followBottom={true}
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

/**
 * The command-center#97 shape: one agent turn carrying hundreds of tool and
 * thinking blocks. Before the transcript split messages into per-unit rows this
 * was a single Virtuoso item, so virtualization bought nothing and the whole
 * turn stayed mounted. Scroll it and the mounted row count stays flat.
 */
const hugeTurn: TranscriptMessage[] = [
  textMessage(
    "user",
    "Work through the whole migration.",
    "2024-06-15T10:00:00Z",
  ),
  {
    role: "assistant",
    timestamp: "2024-06-15T10:01:00Z",
    content: Array.from({ length: 600 }, (_unused, i) =>
      i % 2 === 0
        ? {
            type: "thinking" as const,
            text: `Considering step ${i}`,
            redacted: false,
          }
        : {
            type: "tool_use" as const,
            id: `tool-${i}`,
            name: "Bash",
            input: { command: `step ${i}` },
          },
    ),
  },
];

export const SingleTurnWithHundredsOfBlocks: Story = {
  render: () => (
    <StoryFrame rows={buildConversationRows(hugeTurn, undefined)} />
  ),
};

export const RowMeasurement: Story = {
  render: () => (
    <div>
      <ConversationVirtuosoItem data-testid="margin-row">
        <div>
          <div style={{ marginTop: 12, marginBottom: 18, height: 40 }}>
            Content
          </div>
        </div>
      </ConversationVirtuosoItem>
      <ConversationVirtuosoItem data-testid="empty-row" />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByTestId("margin-row").getBoundingClientRect().height,
    ).toBe(70);
    await expect(
      canvas.getByTestId("empty-row").getBoundingClientRect().height,
    ).toBeGreaterThan(0);
  },
};

const regressionScope = {
  kind: "project",
  projectName: "virtualization-story",
  conversationId: "virtualization-regression",
} as const;
const regressionKey = projectConversationKeys.messages(
  regressionScope.projectName,
  regressionScope.conversationId,
);

function streamingMessage(step: number): TranscriptMessage {
  return {
    role: "assistant",
    timestamp: "2026-09-07T00:00:00Z",
    content: Array.from({ length: step }, (_, index) => [
      {
        type: "thinking" as const,
        text: `Reasoning ${index}: ${"Variable height reasoning. ".repeat((index % 4) + 1)}`,
        redacted: false,
      },
      { type: "text" as const, text: " \n" },
      { type: "tool_result" as const, tool_use_id: `earlier-${index}` },
      {
        type: "text" as const,
        text: `Step ${index}\n\n${"A paragraph with measured spacing. ".repeat((index % 5) + 1)}`,
      },
    ]).flat(),
  };
}

function StreamingRegressionFrame() {
  const [client] = useState(() => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(regressionKey, [streamingMessage(120)]);
    return queryClient;
  });
  const step = useRef(120);
  const [running, setRunning] = useState(false);
  const [nav, setNav] = useState<TranscriptNav>();
  return (
    <QueryClientProvider client={client}>
      <div
        style={{ display: "flex", flexDirection: "column", height: "100vh" }}
      >
        <div>
          <button onClick={() => nav?.handleFirstMessage()}>First</button>
          <button onClick={() => nav?.handleLastMessage()}>Last</button>
          <button
            onClick={() => {
              step.current += 1;
              client.setQueryData(regressionKey, [
                streamingMessage(step.current),
              ]);
            }}
          >
            Append
          </button>
          <button
            onClick={() =>
              client.setQueryData<TranscriptMessage[]>(
                regressionKey,
                (messages) =>
                  messages?.map((message) => ({
                    ...message,
                    content: message.content.map((block, index) =>
                      index === message.content.length - 1 &&
                      block.type === "text"
                        ? {
                            ...block,
                            text: block.text + "\n\nStreaming tail growth.",
                          }
                        : block,
                    ),
                  })),
              )
            }
          >
            Grow tail
          </button>
          <button onClick={() => setRunning((value) => !value)}>
            Toggle working
          </button>
          <span data-testid="follow-state">
            {nav?.followBottom ? "Following" : "Reading"}
          </span>
        </div>
        <ConversationTranscript
          scope={regressionScope}
          backend="claude"
          status={running ? "running" : "awaiting"}
          onNavChange={setNav}
        />
      </div>
    </QueryClientProvider>
  );
}

export const StreamingRegression: Story = {
  render: () => <StreamingRegressionFrame />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() => {
      const rows = canvasElement.querySelectorAll(
        ".conversation-virtuoso-item",
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(80);
      for (const row of rows)
        expect(row.getBoundingClientRect().height).toBeGreaterThan(0);
    });
    const scroller = canvasElement.querySelector<HTMLElement>(
      "[data-virtuoso-scroller]",
    );
    if (!scroller) throw new Error("Transcript scroller did not mount");
    const expectBottom = () =>
      waitFor(
        () => {
          expect(
            scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop,
          ).toBeLessThanOrEqual(4);
          expect(canvas.getByTestId("follow-state")).toHaveTextContent(
            "Following",
          );
        },
        { timeout: 5000 },
      );
    await expectBottom();
    await userEvent.click(
      canvas.getByRole("button", { name: "Toggle working" }),
    );
    for (let i = 0; i < 6; i++)
      await userEvent.click(canvas.getByRole("button", { name: "Append" }));
    await expectBottom();
    for (let i = 0; i < 6; i++)
      await userEvent.click(canvas.getByRole("button", { name: "Grow tail" }));
    await expectBottom();

    fireEvent.pointerDown(scroller);
    scroller.scrollTop = (scroller.scrollHeight - scroller.clientHeight) / 2;
    await waitFor(() =>
      expect(canvas.getByTestId("follow-state")).toHaveTextContent("Reading"),
    );
    fireEvent.pointerUp(window);
    // Let newly mounted rows report their sizes before sampling resting scroll.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const restingTop = scroller.scrollTop;
    await userEvent.click(canvas.getByRole("button", { name: "Append" }));
    await userEvent.click(canvas.getByRole("button", { name: "Grow tail" }));
    for (let i = 0; i < 30; i++) {
      await new Promise(requestAnimationFrame);
      expect(Math.abs(scroller.scrollTop - restingTop)).toBeLessThanOrEqual(1);
    }
    await userEvent.click(canvas.getByRole("button", { name: "Last" }));
    await expectBottom();
    canvasElement.dataset.virtualizationChecks = "passed";
  },
};
