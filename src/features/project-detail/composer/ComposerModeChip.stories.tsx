import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import ComposerModeChip from "./ComposerModeChip";
import "./styles/composer.css";

const meta: Meta<typeof ComposerModeChip> = {
  title: "Project Cockpit/Composer/ModeChip",
  component: ComposerModeChip,
};
export default meta;

type Story = StoryObj<typeof ComposerModeChip>;

export const ChatClaude: Story = {
  args: { mode: "chat", agent: "claude" },
};

export const ChatCodex: Story = {
  args: { mode: "chat", agent: "codex" },
};

export const Command: Story = {
  args: { mode: "command", agent: "claude" },
};

export const Filter: Story = {
  args: { mode: "filter", agent: "claude" },
};

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <ComposerModeChip mode="chat" agent="claude" />
      <ComposerModeChip mode="chat" agent="codex" />
      <ComposerModeChip mode="command" agent="claude" />
      <ComposerModeChip mode="filter" agent="claude" />
    </div>
  ),
};
