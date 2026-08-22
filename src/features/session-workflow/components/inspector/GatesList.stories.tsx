import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import GatesList from "./GatesList";

const meta = {
  title: "SessionWorkflow/Inspector/GatesList",
  component: GatesList,
  args: {
    onOpenGate: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 420,
          padding: 16,
          background: "var(--bg-void)",
          color: "var(--text-primary)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GatesList>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The E2 list: two separate waits on two separate contexts, which is exactly
 * why there is no single global gate to render instead.
 */
export const TwoGates = {
  args: {
    gates: [
      {
        kind: "approval",
        contextId: "context-checkout",
        contextTitle: "Implement checkout",
        detail: "context approval · iteration 2 candidate",
      },
      {
        kind: "question",
        contextId: "context-settings",
        contextTitle: "Settings surface",
        laneKey: "implementer",
        detail: 'parked question · "Should the toggle default to on?"',
      },
    ],
  },
} satisfies Story;

/** A cohort parks per seat, so one context can hold several question rows. */
export const SeveralQuestionsOnOneContext = {
  args: {
    gates: [
      {
        kind: "question",
        contextId: "context-settings",
        contextTitle: "Settings surface",
        laneKey: "implementer",
        detail: 'parked question · "Should the toggle default to on?"',
      },
      {
        kind: "question",
        contextId: "context-settings",
        contextTitle: "Settings surface",
        laneKey: "context_validator:security-reviewer",
        detail: "parked question · 3 questions awaiting you",
      },
    ],
  },
} satisfies Story;

/**
 * A conflicted join is a wait on the human like any other, so §11 routes it
 * here as well as to the lane rail's join card. The row opens the blocked
 * member at Config → Placement.
 */
export const JoinConflict = {
  args: {
    gates: [
      {
        kind: "join",
        joinId: "join_delivery_1",
        contextId: "context-settings",
        contextTitle: "Settings surface",
        detail:
          "join conflict · merging into delivery · Settings surface blocked: both wrote the timeout branch",
      },
    ],
  },
} satisfies Story;

/**
 * Neither the join's frozen roster nor live lane membership can name the
 * blocked member, so the row states the conflict without a control that would
 * navigate nowhere.
 */
export const JoinConflictWithNoDestination = {
  args: {
    gates: [
      {
        kind: "join",
        joinId: "join_delivery_1",
        contextId: null,
        contextTitle: "lane-settings",
        detail:
          "join conflict · merging into delivery · lane-settings blocked: both wrote the timeout branch",
      },
    ],
  },
} satisfies Story;

export const NothingWaiting = {
  args: { gates: [] },
} satisfies Story;
