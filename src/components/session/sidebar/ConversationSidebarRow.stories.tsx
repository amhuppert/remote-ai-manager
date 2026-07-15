import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import ConversationSidebarRow from "@/components/session/sidebar/ConversationSidebarRow";

const BASE_CONVERSATION: SessionActiveConversation = {
  scope: "session",
  id: "convo-01HXAMPLE0000000000000001",
  name: "Add fork lineage badge",
  status: "running",
  lastActivityAt: new Date("2026-05-15T12:30:00Z").toISOString(),
  projectName: "command-center",
  projectPath: "/home/alex/github/command-center",
  sessionName: "feature/sidebar-row",
  agentBackend: "claude",
  summary: "Working on the sidebar row presentational component.",
  pendingQuestion: null,
  pendingQuestionId: null,
  pendingQuestions: null,
  forkedFrom: null,
  debugActive: false,
  role: null,
  branchName: null,
  worktreePath: "/home/alex/github/command-center/.worktrees/sidebar-row",
  lastActivitySummary: "Refactoring the badge layout to use cc-badge tokens.",
  unread: false,
  pendingApproval: null,
};

function buildConversation(
  overrides: Partial<SessionActiveConversation>,
): SessionActiveConversation {
  return { ...BASE_CONVERSATION, ...overrides };
}

const SidebarFrame = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      width: 360,
      background: "var(--bg-surface)",
      border: "1px solid var(--border-subtle)",
      borderRadius: "var(--radius-md)",
      overflow: "hidden",
    }}
  >
    {children}
  </div>
);

const meta = {
  title: "Session/ConversationSidebarRow",
  component: ConversationSidebarRow,
  decorators: [
    (Story) => (
      <SidebarFrame>
        <Story />
      </SidebarFrame>
    ),
  ],
  args: {
    conversation: BASE_CONVERSATION,
    onClick: fn(),
  },
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof ConversationSidebarRow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const StatusNew = {
  args: {
    conversation: buildConversation({
      status: "new",
      lastActivitySummary: "Conversation created, no prompts yet.",
    }),
  },
} satisfies Story;

export const StatusRunning = {
  args: {
    conversation: buildConversation({ status: "running" }),
  },
} satisfies Story;

export const StatusAwaiting = {
  args: {
    conversation: buildConversation({
      status: "awaiting",
      lastActivitySummary: "Last prompt completed; awaiting next instruction.",
    }),
  },
} satisfies Story;

export const StatusWaitingForInput = {
  args: {
    conversation: buildConversation({
      status: "waiting_for_input",
      lastActivitySummary: "Agent asked a clarifying question.",
    }),
  },
} satisfies Story;

export const BackendClaude = {
  args: {
    conversation: buildConversation({ agentBackend: "claude" }),
  },
} satisfies Story;

export const BackendCodex = {
  args: {
    conversation: buildConversation({
      agentBackend: "codex",
      name: "Codex iteration on diff explainer",
    }),
  },
} satisfies Story;

export const ForkSynthetic = {
  args: {
    conversation: buildConversation({
      name: "Synthetic fork from earlier convo",
      forkedFrom: {
        conversationId: "convo-01HSOURCE0000000000000099",
        messageIndex: 14,
        mode: "synthetic",
      },
    }),
  },
} satisfies Story;

export const ForkNative = {
  args: {
    conversation: buildConversation({
      name: "Native fork from earlier convo",
      forkedFrom: {
        conversationId: "convo-01HSOURCE0000000000000099",
        messageIndex: 22,
        mode: "native",
      },
    }),
  },
} satisfies Story;

export const DebugActive = {
  args: {
    conversation: buildConversation({
      debugActive: true,
      name: "Investigating broken merge resolver",
    }),
  },
} satisfies Story;

export const RoleInitialization = {
  args: {
    conversation: buildConversation({
      role: "initialization",
      name: "Graph init: scaffolding contexts",
    }),
  },
} satisfies Story;

export const RoleIteration = {
  args: {
    conversation: buildConversation({
      role: "iteration",
      name: "Iterating on context tasks",
    }),
  },
} satisfies Story;

export const RoleValidator = {
  args: {
    conversation: buildConversation({
      role: "validator",
      name: "Validating context outputs",
    }),
  },
} satisfies Story;

export const RoleNone = {
  args: {
    conversation: buildConversation({ role: null }),
  },
} satisfies Story;

export const AwaitingWithPendingQuestion = {
  args: {
    conversation: buildConversation({
      status: "awaiting",
      pendingQuestion:
        "Should the badge use violet or cyan for the debug-active state?",
      lastActivitySummary: "Awaiting answer on debug badge color.",
    }),
  },
} satisfies Story;

export const ActiveSelected = {
  args: {
    conversation: buildConversation({
      name: "Currently selected conversation",
    }),
    isActive: true,
  },
} satisfies Story;

export const SessionClusterBoundary = {
  render: (args) => (
    <>
      <ConversationSidebarRow
        {...args}
        conversation={buildConversation({
          id: "convo-cluster-1",
          name: "First in session",
          status: "running",
        })}
        isFirstInSession
      />
      <ConversationSidebarRow
        {...args}
        conversation={buildConversation({
          id: "convo-cluster-2",
          name: "Middle of session",
          status: "awaiting",
        })}
      />
      <ConversationSidebarRow
        {...args}
        conversation={buildConversation({
          id: "convo-cluster-3",
          name: "Last in session",
          status: "new",
        })}
        isLastInSession
      />
    </>
  ),
} satisfies Story;

export const KitchenSink = {
  args: {
    conversation: buildConversation({
      status: "running",
      agentBackend: "codex",
      debugActive: true,
      role: "initialization",
      forkedFrom: {
        conversationId: "convo-01HSOURCE0000000000000099",
        messageIndex: 8,
        mode: "native",
      },
      pendingQuestion: null,
    }),
    isActive: true,
  },
} satisfies Story;

export const UnreadFinished = {
  args: {
    conversation: buildConversation({
      status: "awaiting",
      unread: true,
      lastActivitySummary:
        "Built hotkeys help modal \u00b7 +88 / \u22124 \u00b7 ready for review",
    }),
    onAcknowledge: fn(),
  },
} satisfies Story;

export const UnreadFinishedActive = {
  args: {
    conversation: buildConversation({
      status: "awaiting",
      unread: true,
      lastActivitySummary:
        "Refactored validator pipeline \u00b7 ready to merge",
    }),
    isActive: true,
    onAcknowledge: fn(),
  },
} satisfies Story;

export const AwaitingAcknowledged = {
  args: {
    conversation: buildConversation({
      status: "awaiting",
      unread: false,
      lastActivitySummary:
        "Last prompt completed; awaiting next instruction (read).",
    }),
  },
} satisfies Story;
