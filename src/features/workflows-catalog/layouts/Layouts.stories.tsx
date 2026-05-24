import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import OptimisticLayout from "./OptimisticLayout";
import RetryLayout from "./RetryLayout";
import CommitLayout from "./CommitLayout";
import MergeLayout from "./MergeLayout";
import ConversationLayout from "./ConversationLayout";

const meta = {
  title: "Workflows/Layouts",
  parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Optimistic: Story = {
  render: () => (
    <OptimisticLayout selectedStateId={null} onSelectState={fn()} />
  ),
};

export const Retry: Story = {
  render: () => <RetryLayout selectedStateId={null} onSelectState={fn()} />,
};

export const Commit: Story = {
  render: () => <CommitLayout selectedStateId={null} onSelectState={fn()} />,
};

export const Merge: Story = {
  render: () => <MergeLayout selectedStateId={null} onSelectState={fn()} />,
};

export const Conversation: Story = {
  render: () => (
    <ConversationLayout selectedStateId={null} onSelectState={fn()} />
  ),
};

export const ConversationWithSelection: Story = {
  render: () => (
    <ConversationLayout
      selectedStateId={"finalizingTurn"}
      onSelectState={fn()}
    />
  ),
};
