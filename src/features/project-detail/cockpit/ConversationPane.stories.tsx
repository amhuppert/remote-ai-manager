import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import ConversationPane from "./ConversationPane";
import "./styles/cockpit.css";

function FakeTranscript() {
  return (
    <div className="flex min-h-0 flex-1 flex-col p-lg">
      <div className="message user">
        <div className="message-role">You</div>
        <div className="message-content">Refactor the auth module.</div>
      </div>
      <div className="message assistant">
        <div className="message-role">Claude</div>
        <div className="message-content">On it — mapping the flow first.</div>
      </div>
    </div>
  );
}

function FakeComposer() {
  return (
    <div
      style={{
        border: "1px solid var(--border-subtle)",
        borderRadius: "var(--radius-lg)",
        padding: "8px 12px",
        color: "var(--text-tertiary)",
        fontFamily: "var(--font-mono)",
        fontSize: "0.82rem",
      }}
    >
      Message the conversation…
    </div>
  );
}

function FakeDiff() {
  return (
    <EmptyState layoutClassName="grow">
      <EmptyStateTitle>No changes</EmptyStateTitle>
      <EmptyStateDesc>Main worktree is clean.</EmptyStateDesc>
    </EmptyState>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: 560, width: 680, display: "flex" }}>{children}</div>
  );
}

const meta: Meta<typeof ConversationPane> = {
  title: "Project Cockpit/ConversationPane",
  component: ConversationPane,
  decorators: [(Story) => <Frame>{<Story />}</Frame>],
};
export default meta;

type Story = StoryObj<typeof ConversationPane>;

export const Default: Story = {
  args: {
    agentBackend: "claude",
    projectName: "cc-app",
    transcript: <FakeTranscript />,
    composer: <FakeComposer />,
    diffSurface: <FakeDiff />,
  },
};

export const Codex: Story = {
  args: {
    agentBackend: "codex",
    projectName: "cc-app",
    transcript: <FakeTranscript />,
    composer: <FakeComposer />,
    diffSurface: <FakeDiff />,
  },
};
