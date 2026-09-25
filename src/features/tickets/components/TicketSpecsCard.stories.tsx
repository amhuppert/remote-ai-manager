import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import type { TicketSpecReadThrough } from "@/lib/specs/queries";

import { LinkedSpecReadThrough } from "./TicketSpecsCard";

const linkedSpec = {
  specId: "spec-native-sdd",
  slug: "native-sdd",
  name: "Native spec-driven development",
  revision: 4,
  phase: { primary: "executing", authoringFacet: "draft" },
  criteriaProgress: { proven: 9, total: 12 },
  linkedTasks: [
    {
      taskElementId: "task-9",
      taskHandle: "T9",
      sourceTaskState: "current",
      workStatus: "running",
    },
  ],
} satisfies TicketSpecReadThrough["specs"][number];

const meta = {
  title: "Tickets/Detail/SpecReadThrough",
  component: LinkedSpecReadThrough,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full bg-bg-base p-md text-text-primary">
        <Story />
      </div>
    ),
  ],
  args: {
    projectName: "command-center",
    spec: linkedSpec,
  },
} satisfies Meta<typeof LinkedSpecReadThrough>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LiveProgress: Story = {};

export const SourceTaskDrift: Story = {
  args: {
    spec: {
      ...linkedSpec,
      revision: 5,
      linkedTasks: [
        {
          ...linkedSpec.linkedTasks[0]!,
          sourceTaskState: "changed",
        },
      ],
    },
  },
};
