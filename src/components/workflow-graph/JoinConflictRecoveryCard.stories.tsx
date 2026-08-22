import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import JoinConflictRecoveryCard from "./JoinConflictRecoveryCard";
import type { JoinConflictSummary } from "./join-conflict-summary";

const blockedRisk = {
  contextId: "context-risk",
  title: "Risk rules",
  laneId: "lane-risk",
  status: "blocked",
  detail: "both lanes rewrote the rule table",
} satisfies JoinConflictSummary["members"][number];

const summary: JoinConflictSummary = {
  joinId: "join-delivery",
  laneLabel: "delivery",
  members: [
    {
      contextId: "context-checkout",
      title: "Implement checkout",
      laneId: "lane-checkout",
      status: "merged",
      detail: null,
    },
    blockedRisk,
  ],
  mergedCount: 1,
  blockedMember: blockedRisk,
  conflictFiles: ["src/checkout/rules.ts"],
};

const meta = {
  title: "WorkflowGraph/JoinConflictRecoveryCard",
  component: JoinConflictRecoveryCard,
  args: {
    conflictFiles: summary.conflictFiles,
    analysis: null,
    summary,
    isRetrying: false,
    disabled: false,
    onRetry: fn(),
    onOpenLaneWorktree: fn(),
    onEditOwnership: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 520,
          padding: 16,
          background: "var(--bg-void)",
          color: "var(--text-primary)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof JoinConflictRecoveryCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The E2 card: the lane being merged into, which members landed, which one is
 * blocked and in what file, and the three ways out.
 */
export const Default = {} satisfies Story;

/** The failed resolution attempt's own reading of each conflicting file. */
export const WithResolverAnalysis = {
  args: {
    analysis: [
      {
        file: "src/checkout/rules.ts",
        description:
          "Both sides replaced the rule table with incompatible shapes.",
        resolution: "rejected",
        rationale: "Neither side is a superset of the other.",
      },
    ],
  },
} satisfies Story;

export const Retrying = {
  args: { isRetrying: true, disabled: true },
} satisfies Story;

/** A host with no execution to derive the roster from keeps the retry form
 *  alone rather than inventing a membership it cannot know. */
export const WithoutSummary = {
  args: { summary: null },
} satisfies Story;
