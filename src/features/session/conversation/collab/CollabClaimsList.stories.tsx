import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";

const meta = {
  title: "Collab/CollabClaimsList",
  component: CollabClaimsList,
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
} satisfies Meta<typeof CollabClaimsList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty = {
  args: {},
} satisfies Story;

export const AgreeOnly = {
  args: {
    agree: [
      {
        id: "a-1",
        claim: "Schema-first approach",
        ref: { artifact: "agent_two/r1/draft.md", locator: "L42" },
      },
      {
        id: "a-2",
        claim: "Idempotent writes for retries",
      },
    ],
  },
} satisfies Story;

export const FullMix = {
  args: {
    agree: [
      {
        id: "a-1",
        claim: "Schema-first approach",
        ref: { artifact: "agent_two/r1/draft.md", locator: "L42" },
      },
    ],
    disagree: [
      {
        id: "d-1",
        category: "objective",
        severity: "blocking",
        claim: "Whether to ship as v1 or v2",
        reason: "v2 changes the contract for existing consumers",
        proposedResolution: "stay on v1 with additive fields",
        ref: { artifact: "agent_two/r1/draft.md", locator: "L88" },
      },
      {
        id: "d-2",
        category: "implementation",
        severity: "major",
        claim: "Migration order is wrong",
        reason: "writes will lose rows during the swap window",
      },
      {
        id: "d-3",
        category: "implementation",
        severity: "minor",
        claim: "Cache TTL too aggressive",
        reason: "60s eviction will thrash the warm cache",
      },
    ],
    reviseSelf: [
      {
        change: "Add explicit retry budget",
        because: "unbounded retries flagged",
      },
    ],
  },
} satisfies Story;
