import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";
import { createWorkflowDefinition } from "@/lib/workflow-graph/test-fixtures";
import LaneMovePicker from "./LaneMovePicker";

/**
 * M1's touch re-placement picker. Each row carries the drag's own preview label
 * and its accepted-or-refused verdict, so what a phone reads before choosing is
 * what a pointer reads while hovering.
 */
function definition(): WorkflowSemanticDefinition {
  return {
    ...createWorkflowDefinition(),
    executionContexts: [
      {
        id: "ctx_checkout",
        title: "Implement checkout",
        acceptanceCriteria: "Checkout works end to end.",
        placement: {
          lane: "delivery",
          mode: "owned",
          ownedPaths: ["src/checkout", "src/risk"],
        },
      },
      {
        id: "ctx_rollout",
        title: "Rollout switch",
        acceptanceCriteria: "The flag flips cleanly.",
        placement: { lane: "delivery", mode: "full" },
      },
      {
        id: "ctx_docs",
        title: "Update the runbook",
        acceptanceCriteria: "The runbook matches the new flow.",
        placement: { lane: "plan", mode: "owned", ownedPaths: ["docs"] },
      },
    ],
    tasks: [],
    edges: [],
  };
}

const meta = {
  title: "WorkflowsBuilder/LaneMovePicker",
  component: LaneMovePicker,
  parameters: { layout: "centered", backgrounds: { default: "dark" } },
  args: {
    definition: definition(),
    laneNames: ["delivery", "plan", "session"],
    onResolve: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof LaneMovePicker>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An owning member. `session` is marked refused — it admits read-only contexts
 * only — and `delivery` is out of the choices because it is already home.
 */
export const OwningMember: Story = {
  args: { contextId: "ctx_checkout" },
};

/**
 * A full-access member, which needs its lane to itself — so `plan` is legal and
 * the canvas will say what it costs once the choice is made.
 */
export const FullAccessMember: Story = {
  args: { contextId: "ctx_rollout" },
};

/** Closed — a picker with no context to re-place shows nothing at all. */
export const Closed: Story = {
  args: { contextId: null },
};
