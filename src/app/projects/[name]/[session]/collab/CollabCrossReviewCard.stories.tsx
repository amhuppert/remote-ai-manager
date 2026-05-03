import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import {
  makeAgentTwoCrossReview,
  makeBlockingImplementationDisagreement,
  makeMinorImplementationDisagreement,
  makeObjectiveDisagreement,
  makeReviseSelf,
} from "@/lib/workflows/collaboration/test-fixtures";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import CollabCrossReviewCard, {
  type CollabCrossReviewCardProps,
} from "./CollabCrossReviewCard";

const meta = {
  title: "Collab/CollabCrossReviewCard",
  component: CollabCrossReviewCard,
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
} satisfies Meta<typeof CollabCrossReviewCard>;

export default meta;
type Story = StoryObj<typeof meta>;

function fromCrossReviewFixture(
  fixture: ReturnType<typeof makeAgentTwoCrossReview>,
  reviewerBackend: CollaborationAgent,
  targetBackend: CollaborationAgent,
): Omit<CollabCrossReviewCardProps, "onRefClick"> {
  return {
    reviewerAgent: reviewerBackend,
    targetAgent: targetBackend,
    narrative: fixture.narrative,
    supporting: fixture.supporting,
    agree: fixture.agree,
    disagree: fixture.disagree,
    reviseSelf: fixture.reviseSelf,
  };
}

export const CodexReviewsClaudeFromFixture = {
  args: fromCrossReviewFixture(
    makeAgentTwoCrossReview({
      disagree: [
        makeBlockingImplementationDisagreement(),
        makeMinorImplementationDisagreement(),
      ],
      reviseSelf: [makeReviseSelf()],
    }),
    "codex",
    "claude",
  ),
} satisfies Story;

export const ClaudeReviewsCodexFromFixture = {
  args: fromCrossReviewFixture(
    makeAgentTwoCrossReview({
      agent: "agent_one",
      targetAgent: "agent_two",
      narrative:
        "Claude reviewing Codex's draft — objective scope concern blocks acceptance.",
      agree: [],
      disagree: [makeObjectiveDisagreement()],
      reviseSelf: [],
    }),
    "claude",
    "codex",
  ),
} satisfies Story;
