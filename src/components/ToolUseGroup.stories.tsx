import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { MessageContentBlock } from "@/types";
import ToolUseGroup from "./ToolUseGroup";

const meta = {
  title: "Components/ToolUseGroup",
  component: ToolUseGroup,
  decorators: [
    (Story) => (
      <div
        style={{
          background: "var(--bg-surface)",
          padding: "var(--space-md)",
          maxWidth: 700,
          borderLeft: "2px solid var(--cyan-dim)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ToolUseGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoToolUses = {
  args: {
    blocks: [
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "found 3 matches",
      },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/lib/sessions.ts" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: "file contents...",
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const ManyToolUses = {
  args: {
    blocks: [
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "sidebar-dot|unified-panel-dot" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "results...",
      },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: "results...",
      },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "\\.waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_3",
        content: "results...",
      },
      {
        type: "tool_use",
        name: "Glob",
        input: { pattern: "**/*UnifiedPanel*.tsx" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_4",
        content: "results...",
      },
      {
        type: "tool_use",
        name: "Read",
        input: {
          file_path:
            "/home/alex/github/remote-ai-manager/.worktrees/fix-waiting-for-endpoint-style/src/components/UnifiedPanel.tsx",
        },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_5",
        content: "file contents...",
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const MixedToolNames = {
  args: {
    blocks: [
      {
        type: "tool_use",
        name: "Task",
        input: { description: "Find waiting_for_input styling" },
      },
      { type: "tool_result", tool_use_id: "t1" },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "waiting_for_input|WAITING_FOR_INPUT" },
      },
      { type: "tool_result", tool_use_id: "t2" },
      { type: "tool_use", name: "Glob", input: { pattern: "**/*.css" } },
      { type: "tool_result", tool_use_id: "t3" },
      {
        type: "tool_use",
        name: "Glob",
        input: { pattern: '**/*"status"*.ts*' },
      },
      { type: "tool_result", tool_use_id: "t4" },
      {
        type: "tool_use",
        name: "Grep",
        input: {
          pattern:
            'status."indicator|status."dot|conversation."status|awaiting|running',
        },
      },
      { type: "tool_result", tool_use_id: "t5" },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: 'className."status|status."className' },
      },
      { type: "tool_result", tool_use_id: "t6" },
      {
        type: "tool_use",
        name: "Read",
        input: {
          file_path:
            "/home/alex/github/remote-ai-manager/.worktrees/fix-waiting-for-endpoint-style/src/app/globals.css",
        },
      },
      { type: "tool_result", tool_use_id: "t7" },
      {
        type: "tool_use",
        name: "Grep",
        input: {
          pattern: "amber|orange|\\.awaiting|\\.running|--status|dot|indicator",
        },
      },
      { type: "tool_result", tool_use_id: "t8" },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;
