import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import type { SessionActiveConversation } from "@/lib/active-conversations/schemas";
import EmptyConversationWorkingSet from "./EmptyConversationWorkingSet";

function conversation(id: string, name: string): SessionActiveConversation {
  return {
    id,
    scope: "session",
    name,
    status: "awaiting",
    lastActivityAt: "2026-07-27T12:00:00.000Z",
    projectName: "command-center",
    projectPath: "/repo",
    agentBackend: "claude",
    summary: null,
    pendingQuestion: null,
    pendingQuestionId: null,
    pendingQuestions: null,
    forkedFrom: null,
    debugActive: false,
    role: null,
    worktreePath: "/repo/.worktrees/hotkeys",
    lastActivitySummary: null,
    unread: false,
    pendingApproval: null,
    sessionName: "hotkeys",
    branchName: "cc/hotkeys",
  };
}

const meta = {
  title: "Session/EmptyConversationWorkingSet",
  component: EmptyConversationWorkingSet,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="flex min-h-[500px] bg-bg-base">
        <Story />
      </div>
    ),
  ],
  args: {
    addableConversations: [
      conversation("keyboard-audit", "Keyboard audit"),
      conversation("dispatcher", "Dispatcher tests"),
    ],
    onAdd: fn(),
  },
} satisfies Meta<typeof EmptyConversationWorkingSet>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NoAvailableConversations: Story = {
  args: {
    addableConversations: [],
  },
};
