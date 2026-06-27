import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabCounterProposalCard, {
  type CollabCounterProposalCardProps,
} from "@/features/session/conversation/collab/CollabCounterProposalCard";

const meta = {
  title: "Collab/CollabCounterProposalCard",
  component: CollabCounterProposalCard,
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
} satisfies Meta<typeof CollabCounterProposalCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromCounterProposalFixture(
  fixture: ReturnType<typeof makeAgentTwoCounterProposalRound1>,
  fromBackend: CollaborationAgent,
  round: number,
): Omit<CollabCounterProposalCardProps, "onRefClick"> {
  return {
    fromAgent: fromBackend,
    round,
    summary: fixture.summary,
    artifacts: fixture.artifacts,
    accepted_change_ids: fixture.accepted_change_ids,
    rejected_change_ids: fixture.rejected_change_ids,
    alternative_changes: fixture.alternative_changes,
    agree: fixture.agree,
    disagree: fixture.disagree,
  };
}

export const Round1CodexFromFixture = {
  args: fromCounterProposalFixture(
    makeAgentTwoCounterProposalRound1({
      accepted_change_ids: ["PC-1"],
      rejected_change_ids: ["PC-2"],
    }),
    "codex",
    1,
  ),
} satisfies Story;

export const Round2CodexFromFixture = {
  args: fromCounterProposalFixture(
    makeAgentTwoCounterProposalRound2(),
    "codex",
    2,
  ),
} satisfies Story;
