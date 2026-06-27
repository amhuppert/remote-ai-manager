import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { makeAgentOneProposedChanges } from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabProposedChangesCard, {
  type CollabProposedChangesCardProps,
} from "@/features/session/conversation/collab/CollabProposedChangesCard";

const meta = {
  title: "Collab/CollabProposedChangesCard",
  component: CollabProposedChangesCard,
  args: {
    onRefClick: fn(),
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 640, padding: 16 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabProposedChangesCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromProposedChangesFixture(
  fixture: ReturnType<typeof makeAgentOneProposedChanges>,
  fromBackend: CollaborationAgent,
  round: number,
): Omit<CollabProposedChangesCardProps, "onRefClick"> {
  return {
    fromAgent: fromBackend,
    round,
    summary: fixture.summary,
    artifacts: fixture.artifacts,
    accepted_from_other_agent_draft: fixture.accepted_from_other_agent_draft,
    proposed_changes: fixture.proposed_changes,
    remaining_disagreements: fixture.remaining_disagreements,
  };
}

export const Round1ClaudeFromFixture = {
  args: fromProposedChangesFixture(makeAgentOneProposedChanges(), "claude", 1),
} satisfies Story;
