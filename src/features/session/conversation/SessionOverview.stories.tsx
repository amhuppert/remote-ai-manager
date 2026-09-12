import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { publicConversationStateSchema } from "@/lib/conversations/schemas";
import { publicSessionStateSchema } from "@/lib/sessions/schemas";
import { Button } from "@/components/ui/Button";
import { Switch } from "@/components/ui/Switch";
import { PlusIcon } from "@/components/icons";
import SessionOverview, { SessionOverviewPending } from "./SessionOverview";
import { GraphWorkflowLauncher } from "./GraphWorkflowCard";

const conversations = [
  publicConversationStateSchema.parse({
    id: "release-review",
    name: "Release readiness review",
    summary: "Confirm the rollout plan before publishing the release.",
    status: "waiting_for_input",
    promptCount: 12,
    transcriptPath: null,
    agentBackend: "claude",
    unread: true,
    createdAt: "2026-09-11T09:00:00Z",
    lastActivityAt: "2026-09-11T14:32:00Z",
  }),
  publicConversationStateSchema.parse({
    id: "billing-tests",
    name: "Billing edge cases",
    summary:
      "Validating subscription changes, retries, and cancellation behavior.",
    status: "running",
    promptCount: 8,
    transcriptPath: null,
    agentBackend: "codex",
    createdAt: "2026-09-11T09:00:00Z",
    lastActivityAt: "2026-09-11T14:35:00Z",
  }),
  publicConversationStateSchema.parse({
    id: "onboarding",
    name: "Onboarding polish",
    summary: "Empty states and account setup are ready for review.",
    status: "awaiting",
    promptCount: 6,
    transcriptPath: null,
    agentBackend: "claude",
    createdAt: "2026-09-11T09:00:00Z",
    lastActivityAt: "2026-09-11T13:48:00Z",
  }),
  publicConversationStateSchema.parse({
    id: "release-notes",
    name: "Release notes",
    status: "new",
    promptCount: 0,
    transcriptPath: null,
    agentBackend: "codex",
    createdAt: "2026-09-11T09:00:00Z",
    lastActivityAt: "2026-09-11T12:10:00Z",
  }),
  publicConversationStateSchema.parse({
    id: "archived-audit",
    name: "Initial launch audit",
    status: "awaiting",
    promptCount: 5,
    transcriptPath: null,
    archived: true,
    createdAt: "2026-09-10T09:00:00Z",
    lastActivityAt: "2026-09-10T14:00:00Z",
  }),
];

const session = publicSessionStateSchema.parse({
  sessionName: "Commercial release readiness",
  branchName: "csm/commercial-release-readiness-c27aac",
  worktreePath:
    "/repos/active-recall/.worktrees/commercial-release-readiness-c27aac",
  createdAt: "2026-09-11T09:00:00Z",
  lastActivityAt: "2026-09-11T14:35:00Z",
  conversations,
});

function WorkspaceTools() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="flex flex-col gap-lg">
      <div className="flex items-center justify-between text-[0.78rem]">
        <span>Dev servers</span>
        <span className="text-[0.7rem] text-green">2 running</span>
      </div>
      <label className="flex min-h-[44px] items-center justify-between text-[0.78rem]">
        Red-green TDD
        <Switch checked={enabled} onCheckedChange={setEnabled} tone="green" />
      </label>
      <Button size="sm" touch>
        Session alignment
      </Button>
      <Button size="sm" touch>
        Agent capabilities
      </Button>
    </div>
  );
}

const meta = {
  title: "Session/Overview",
  component: SessionOverview,
  parameters: { layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="h-dvh overflow-y-auto">
        <Story />
      </div>
    ),
  ],
  args: {
    projectName: "active-recall",
    session,
    conversations,
    showArchived: false,
    onToggleArchived: fn(),
    onArchive: fn(),
    onRename: fn().mockResolvedValue(undefined),
    sessionActions: (
      <Button size="sm" touch>
        Session actions
      </Button>
    ),
    createAction: (
      <Button variant="primary" touch>
        <PlusIcon size={16} />
        New conversation
      </Button>
    ),
    workspaceTools: <WorkspaceTools />,
    workflow: (
      <GraphWorkflowLauncher
        projectName="active-recall"
        sessionName={session.sessionName}
        definitions={[
          {
            id: "delivery",
            name: "Feature delivery",
            revision: 3,
            tier: "project",
          },
          { id: "review", name: "Code review", revision: 2, tier: "global" },
        ]}
        onRun={fn()}
      />
    ),
  },
  render: function Demo(args) {
    const [rows, setRows] = useState(args.conversations);
    const [showArchived, setShowArchived] = useState(args.showArchived);
    return (
      <SessionOverview
        {...args}
        conversations={rows}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived(!showArchived)}
        onArchive={(id, archived) =>
          setRows((current) =>
            current.map((row) => (row.id === id ? { ...row, archived } : row)),
          )
        }
        onRename={async (id, name) => {
          setRows((current) =>
            current.map((row) => (row.id === id ? { ...row, name } : row)),
          );
        }}
      />
    );
  },
} satisfies Meta<typeof SessionOverview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const ActiveSession: Story = {};
export const QuietSession: Story = {
  args: {
    session: { ...session, conversations: conversations.slice(2, 4) },
    conversations: conversations.slice(2, 4),
  },
};
export const EmptySession: Story = {
  args: { session: { ...session, conversations: [] }, conversations: [] },
};
export const MergedSession: Story = {
  args: {
    session: { ...session, finished: true },
    conversations: conversations.map((conversation) => ({
      ...conversation,
      status: "awaiting",
    })),
    createAction: <Button disabled>New conversation</Button>,
    workflow: null,
  },
};
export const ArchivedConversations: Story = { args: { showArchived: true } };
export const ConversationError: Story = {
  args: {
    conversationError:
      "The server could not be reached. Your conversations are preserved.",
    onRetryConversations: fn(),
  },
};
export const LoadingSession: Story = {
  render: () => (
    <SessionOverviewPending sessionName={session.sessionName} onRetry={fn()} />
  ),
};
export const LongNames: Story = {
  args: {
    session: {
      ...session,
      sessionName:
        "Commercial release readiness and subscription lifecycle verification",
      worktreePath:
        "/repos/active-recall/.worktrees/commercial-release-readiness-and-subscription-lifecycle-verification-c27aac",
    },
    conversations: [
      {
        ...publicConversationStateSchema.parse(conversations[0]),
        name: "Verify idempotency across subscription-renewal-webhook-reconciliation-and-account-migration",
      },
    ],
  },
};
