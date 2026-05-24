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
    narrative: fixture.narrative,
    acceptedFromAgentTwoDraft: fixture.acceptedFromAgentTwoDraft,
    proposedChanges: fixture.proposedChanges,
    remainingDisagreements: fixture.remainingDisagreements,
    supporting: fixture.supporting,
  };
}

export const Round1ClaudeFromFixture = {
  args: fromProposedChangesFixture(makeAgentOneProposedChanges(), "claude", 1),
} satisfies Story;
