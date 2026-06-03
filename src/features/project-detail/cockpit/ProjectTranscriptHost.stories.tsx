import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ProjectTranscriptHost from "./ProjectTranscriptHost";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import type { SpawnCardRowData } from "./spawn-card-slot";
import { withSeededQueryClient } from "./story-support";

const PROJECT = "command-center";
const CONV = "plc-1";

const messages: TranscriptMessage[] = [
  {
    role: "user",
    content: [{ type: "text", text: "Refactor the auth module." }],
    timestamp: "2026-01-01T00:00:00Z",
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "I'll start by mapping the current auth flow." },
    ],
    timestamp: "2026-01-01T00:00:05Z",
    model: "opus",
    effort: "high",
  },
  {
    role: "user",
    content: [{ type: "text", text: "Sounds good." }],
    timestamp: "2026-01-01T00:01:00Z",
  },
];

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ height: 420, width: 620, display: "flex" }}>{children}</div>
  );
}

const meta: Meta<typeof ProjectTranscriptHost> = {
  title: "Project Cockpit/ProjectTranscriptHost",
  component: ProjectTranscriptHost,
  decorators: [(Story) => <Frame>{<Story />}</Frame>],
};
export default meta;

type Story = StoryObj<typeof ProjectTranscriptHost>;

export const MessagesOnly: Story = {
  decorators: [
    withSeededQueryClient([
      [projectConversationKeys.messages(PROJECT, CONV), messages],
    ]),
  ],
  args: {
    projectName: PROJECT,
    conversationId: CONV,
    selectedBackend: "claude",
  },
};

const sampleCard: SpawnCardRowData = {
  kind: "spawn-card",
  proposalId: "sp-1",
  anchorMessageIndex: 1,
};

export const WithSpawnCardSlot: Story = {
  decorators: [
    withSeededQueryClient([
      [projectConversationKeys.messages(PROJECT, CONV), messages],
    ]),
  ],
  args: {
    projectName: PROJECT,
    conversationId: CONV,
    selectedBackend: "claude",
    spawnCards: [sampleCard],
    renderSpawnCardRow: (row) => (
      <div
        style={{
          margin: "8px 0",
          padding: 12,
          border: "1px solid var(--cyan-glow)",
          borderRadius: "var(--radius-md)",
          color: "var(--cyan)",
          fontFamily: "var(--font-mono)",
          fontSize: "0.74rem",
        }}
      >
        spawn-card slot — proposal {row.proposalId}
      </div>
    ),
  },
};

export const Empty: Story = {
  decorators: [
    withSeededQueryClient([
      [projectConversationKeys.messages(PROJECT, CONV), []],
    ]),
  ],
  args: {
    projectName: PROJECT,
    conversationId: CONV,
    selectedBackend: "claude",
  },
};
