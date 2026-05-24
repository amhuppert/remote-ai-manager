import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import CollabSeverityCategoryChip from "@/features/session/conversation/collab/CollabSeverityCategoryChip";

const meta = {
  title: "Collab/CollabSeverityCategoryChip",
  component: CollabSeverityCategoryChip,
  decorators: [
    (Story) => (
      <div
        style={{
          padding: 16,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          alignItems: "flex-start",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CollabSeverityCategoryChip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ObjectiveBlocking = {
  args: { category: "objective", severity: "blocking" },
} satisfies Story;

export const ObjectiveMajor = {
  args: { category: "objective", severity: "major" },
} satisfies Story;

export const ObjectiveMinor = {
  args: { category: "objective", severity: "minor" },
} satisfies Story;

export const ImplementationBlocking = {
  args: { category: "implementation", severity: "blocking" },
} satisfies Story;

export const ImplementationMajor = {
  args: { category: "implementation", severity: "major" },
} satisfies Story;

export const ImplementationMinor = {
  args: { category: "implementation", severity: "minor" },
} satisfies Story;
