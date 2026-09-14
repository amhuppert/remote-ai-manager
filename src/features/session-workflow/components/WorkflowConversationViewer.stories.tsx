import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { publicSessionStateSchema } from "@/lib/sessions/schemas";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import WorkflowConversationViewer from "./WorkflowConversationViewer";

/**
 * The Log surface (README §11, design M2's third phone): one workflow
 * conversation, titled by the conversation and the role that owns it, with a
 * live/ended pill and a close control that returns to the graph. Conversation
 * prose renders in the body font; the id, the role, the pill and the breadcrumb
 * stay mono.
 *
 * An implementer entry and a validator entry are both here because they are
 * independently reachable — a conversation row opens the first, a verdict opens
 * the second — and the header is the only thing that tells them apart.
 */

const PROJECT = "command-center";
const SESSION = "session-1";

type StoryMessage = {
  seq: number;
  role: "user" | "assistant";
  content: { type: "text"; text: string }[];
  timestamp: string;
  model?: string;
  origin:
    | { source: "user" }
    | {
        source: "workflow";
        workflow: {
          executionId: string;
          nodeId: string;
          iterationIndex: number;
        };
      };
};

function workflowOrigin(iterationIndex: number): StoryMessage["origin"] {
  return {
    source: "workflow",
    workflow: {
      executionId: "execution-1",
      nodeId: "context-implement",
      iterationIndex,
    },
  };
}

const IMPLEMENTER_MESSAGES: StoryMessage[] = [
  {
    seq: 0,
    role: "user",
    content: [
      {
        type: "text",
        text: "Write the timeout-path audit record. The success branch already writes one.",
      },
    ],
    timestamp: "2026-03-27T10:52:00.000Z",
    origin: workflowOrigin(2),
  },
  {
    seq: 1,
    role: "assistant",
    content: [
      {
        type: "text",
        text: 'The timeout branch now writes the same audit record as the success branch. I kept the migration additive — the new columns are nullable and backfilled in a follow-up task.\n\n```ts\nawait writeAuditRecord({ outcome: "timeout", requestId });\n```',
      },
    ],
    timestamp: "2026-03-27T11:04:00.000Z",
    model: "opus",
    origin: workflowOrigin(2),
  },
];

const VALIDATOR_MESSAGES: StoryMessage[] = [
  {
    seq: 0,
    role: "user",
    content: [
      {
        type: "text",
        text: "Review the candidate against your seat mandate: **security**.",
      },
    ],
    timestamp: "2026-03-27T10:40:00.000Z",
    origin: workflowOrigin(1),
  },
  {
    seq: 1,
    role: "assistant",
    content: [
      {
        type: "text",
        text: "Tracing every write on the timeout path to an audit record, per the seat mandate. Risk rules bypass the audit log there, so I am rejecting this round.",
      },
    ],
    timestamp: "2026-03-27T10:42:00.000Z",
    model: "opus",
    origin: workflowOrigin(1),
  },
];

/**
 * Storybook has no MSW layer, so the transcript's own fetch is answered here.
 * Session metadata supplies each conversation's persisted backend identity.
 */
function stubMessages(byConversation: Record<string, StoryMessage[]>) {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  window.fetch = (input: RequestInfo | URL) => {
    const url = String(typeof input === "string" ? input : input.toString());
    if (url.endsWith(`/api/projects/${PROJECT}/sessions/${SESSION}`)) {
      return Promise.resolve(
        json(
          publicSessionStateSchema.parse({
            sessionName: SESSION,
            worktreePath: "/repo",
            branchName: "story",
            createdAt: "2026-01-01T00:00:00.000Z",
            lastActivityAt: "2026-01-01T00:00:00.000Z",
            conversations: Object.keys(byConversation).map((id) =>
              toPublicConversationState(
                makeConversationState({
                  id,
                  agentBackend: id === "conv_cursor" ? "cursor" : "claude",
                }),
              ),
            ),
          }),
        ),
      );
    }
    for (const [conversationId, messages] of Object.entries(byConversation)) {
      if (url.includes(`/conversations/${conversationId}/messages`)) {
        return Promise.resolve(json(messages));
      }
    }
    return Promise.resolve(json({}, 404));
  };
}

function LogDecorator(Story: React.ComponentType) {
  stubMessages({
    conv_b41f: IMPLEMENTER_MESSAGES,
    conv_cursor: IMPLEMENTER_MESSAGES.map((message) => ({
      ...message,
      ...(message.role === "assistant" ? { model: "composer-2.5" } : {}),
    })),
    conv_val_security_1: VALIDATOR_MESSAGES,
  });
  return (
    <div className="flex h-[640px] w-[520px] max-w-[calc(100vw-32px)] flex-col bg-bg-void">
      <Story />
    </div>
  );
}

const meta = {
  title: "Workflow/LogSurface",
  component: WorkflowConversationViewer,
  decorators: [LogDecorator],
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
  args: {
    projectName: PROJECT,
    sessionName: SESSION,
    onClose: fn(),
  },
} satisfies Meta<typeof WorkflowConversationViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Opened from a task: the breadcrumb still names the context AND the task. */
export const ImplementerLive: Story = {
  args: {
    conversationId: "conv_b41f",
    role: "Implementer",
    contextTitle: "Implement checkout",
    taskTitle: "Write the timeout-path audit record",
    isLive: true,
  },
};

/**
 * Opened from a verdict: the seat's own transcript. It belongs to a lane rather
 * than a task, so the breadcrumb names the context alone.
 */
export const ValidatorEnded: Story = {
  args: {
    conversationId: "conv_val_security_1",
    role: "Validator · security",
    contextTitle: "Implement checkout",
    isLive: false,
  },
};

export const CursorImplementer: Story = {
  args: {
    conversationId: "conv_cursor",
    role: "Implementer",
    contextTitle: "Cursor owned context",
    taskTitle: "Write the timeout-path audit record",
    isLive: false,
  },
};
