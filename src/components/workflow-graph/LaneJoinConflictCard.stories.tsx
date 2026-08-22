import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import LaneJoinConflictCard from "./LaneJoinConflictCard";
import type { JoinConflictMember } from "./join-conflict-summary";

const meta = {
  title: "WorkflowGraph/LaneJoinConflictCard",
  component: LaneJoinConflictCard,
  args: {
    onOpenLaneWorktree: fn(),
    onEditOwnership: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          minHeight: 320,
          width: 780,
          padding: 16,
          background: "var(--bg-void)",
          color: "var(--text-primary)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof LaneJoinConflictCard>;

export default meta;
type Story = StoryObj<typeof meta>;

const blockedSettings: JoinConflictMember = {
  laneId: "lane-settings",
  contextId: "ctx_settings",
  title: "Settings surface",
  status: "blocked",
  detail: "both wrote the timeout branch",
};

/**
 * The E2 join card on the lane rail: one member merged, one blocked, and the
 * two ways out of the blocked member. Retrying the merge stays on the halt
 * card, which owns the conflict-guidance form and the mutation.
 */
export const Blocked = {
  args: {
    summary: {
      joinId: "join_delivery_1",
      laneLabel: "delivery",
      mergedCount: 1,
      blockedMember: blockedSettings,
      conflictFiles: ["src/checkout/audit.ts"],
      members: [
        {
          laneId: "lane-rules",
          contextId: "ctx_rules",
          title: "Pricing rules",
          status: "merged",
          detail: null,
        },
        blockedSettings,
        {
          laneId: "lane-rollout",
          contextId: "ctx_rollout",
          title: "Rollout",
          status: "pending",
          detail: null,
        },
      ],
    },
  },
} satisfies Story;

/**
 * A blocked LANE carrying several contexts: every one of them failed to land,
 * so the roster reports them all blocked — but the sentence and the two
 * controls name and act on the single member the summary chose.
 */
export const SeveralContextsInTheBlockedLane = {
  args: {
    summary: {
      joinId: "join_delivery_1",
      laneLabel: "delivery",
      mergedCount: 1,
      blockedMember: blockedSettings,
      conflictFiles: ["src/checkout/audit.ts"],
      members: [
        {
          laneId: "lane-rules",
          contextId: "ctx_rules",
          title: "Pricing rules",
          status: "merged",
          detail: null,
        },
        {
          laneId: "lane-settings",
          contextId: "ctx_audit",
          title: "Audit trail",
          status: "blocked",
          detail: "both wrote the timeout branch",
        },
        blockedSettings,
      ],
    },
  },
} satisfies Story;

/**
 * Neither the join's frozen roster nor live lane membership knows what the
 * blocked lane carried, so the card states the conflict and offers no controls.
 */
export const NoBlockedMemberToOpen = {
  args: {
    summary: {
      joinId: "join_delivery_1",
      laneLabel: "delivery",
      mergedCount: 1,
      blockedMember: {
        laneId: "lane-settings",
        contextId: null,
        title: "lane-settings",
        status: "blocked",
        detail: "the merge runner stopped before naming a member",
      },
      conflictFiles: [],
      members: [
        {
          laneId: "lane-rules",
          contextId: null,
          title: "lane-rules",
          status: "merged",
          detail: null,
        },
        {
          laneId: "lane-settings",
          contextId: null,
          title: "lane-settings",
          status: "blocked",
          detail: "the merge runner stopped before naming a member",
        },
      ],
    },
  },
} satisfies Story;
