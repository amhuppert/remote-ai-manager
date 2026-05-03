import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeAgentTwoCounterProposalRound1,
  makeAgentTwoCounterProposalRound2,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabCounterProposalCard, {
  type CollabCounterProposalCardProps,
} from "./CollabCounterProposalCard";

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
    narrative: fixture.narrative,
    acceptedProposedChangeIds: fixture.acceptedProposedChangeIds,
    rejectedProposedChangeIds: fixture.rejectedProposedChangeIds,
    alternativeChanges: fixture.alternativeChanges,
    agree: fixture.agree,
    disagree: fixture.disagree,
    supporting: fixture.supporting,
  };
}

export const Round1CodexFromFixture = {
  args: fromCounterProposalFixture(
    makeAgentTwoCounterProposalRound1({
      acceptedProposedChangeIds: ["PC-1"],
      rejectedProposedChangeIds: ["PC-2"],
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
