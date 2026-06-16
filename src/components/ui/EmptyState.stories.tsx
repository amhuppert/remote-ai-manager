import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  EmptyState,
  EmptyStateIcon,
  EmptyStateTitle,
  EmptyStateDesc,
} from "./EmptyState";

const meta = {
  title: "UI/EmptyState",
  component: EmptyState,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof EmptyState>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Full composition: icon + title + description. */
export const Default: Story = {
  render: () => (
    <EmptyState>
      <EmptyStateIcon>📭</EmptyStateIcon>
      <EmptyStateTitle>No sessions yet</EmptyStateTitle>
      <EmptyStateDesc>
        Create a session to start working in an isolated worktree. Sessions
        appear here once they exist.
      </EmptyStateDesc>
    </EmptyState>
  ),
};

/** Title + description only (no icon) — a common compact variant. */
export const NoIcon: Story = {
  render: () => (
    <EmptyState>
      <EmptyStateTitle>Nothing to show</EmptyStateTitle>
      <EmptyStateDesc>Adjust your filters to see more results.</EmptyStateDesc>
    </EmptyState>
  ),
};
