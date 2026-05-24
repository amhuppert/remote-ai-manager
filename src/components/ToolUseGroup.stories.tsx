import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import ToolUseGroup from "./ToolUseGroup";
import { buildToolResultLookup } from "./MessageContent";

interface StoryArgs {
  blocks: MessageContentBlock[];
  worktreePath?: string;
}

const meta: Meta<StoryArgs> = {
  title: "Components/ToolUseGroup",
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
  render: ({ blocks, worktreePath }) => (
    <ToolUseGroup
      blocks={blocks}
      worktreePath={worktreePath}
      resultLookup={buildToolResultLookup(blocks)}
    />
  ),
};

export default meta;
type Story = StoryObj<StoryArgs>;

const WORKTREE = "/home/alex/github/remote-ai-manager/.worktrees/feature-x";

export const TwoToolUses = {
  args: {
    worktreePath: WORKTREE,
    blocks: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "Grep",
        input: { pattern: "waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "src/a.ts:10: foo\nsrc/b.ts:20: foo\nsrc/c.ts:30: foo",
        metrics: { matchCount: 3 },
      },
      {
        type: "tool_use",
        id: "tool_2",
        name: "Read",
        input: { file_path: `${WORKTREE}/src/lib/sessions.ts` },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: "file contents...",
        metrics: { lineCount: 184 },
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const WithErrors = {
  args: {
    worktreePath: WORKTREE,
    blocks: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "Bash",
        input: {
          command: "git push origin main",
          description: "Push branch to origin",
        },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "fatal: Authentication failed",
        isError: true,
        metrics: { exitCode: 128 },
      },
      {
        type: "tool_use",
        id: "tool_2",
        name: "Read",
        input: { file_path: `${WORKTREE}/src/lib/missing.ts` },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: "ENOENT: no such file or directory",
        isError: true,
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const ManyToolUses = {
  args: {
    worktreePath: WORKTREE,
    blocks: [
      {
        type: "tool_use",
        id: "tool_1",
        name: "Grep",
        input: { pattern: "sidebar-dot|unified-panel-dot" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "src/a.ts:1\nsrc/b.ts:2",
        metrics: { matchCount: 2 },
      },
      {
        type: "tool_use",
        id: "tool_2",
        name: "Grep",
        input: { pattern: "waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_2",
        content: "Found 5 files",
        metrics: { fileCount: 5 },
      },
      {
        type: "tool_use",
        id: "tool_3",
        name: "Grep",
        input: { pattern: "\\.waiting_for_input" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_3",
        content: "results...",
        metrics: { matchCount: 7 },
      },
      {
        type: "tool_use",
        id: "tool_4",
        name: "Glob",
        input: { pattern: "**/*UnifiedPanel*.tsx" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_4",
        content: "src/x.tsx\nsrc/y.tsx",
        metrics: { fileCount: 2 },
      },
      {
        type: "tool_use",
        id: "tool_5",
        name: "Read",
        input: { file_path: `${WORKTREE}/src/components/UnifiedPanel.tsx` },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_5",
        content: "file contents...",
        metrics: { lineCount: 312 },
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const MixedToolNames = {
  args: {
    worktreePath: WORKTREE,
    blocks: [
      {
        type: "tool_use",
        id: "t1",
        name: "Task",
        input: { description: "Find waiting_for_input styling" },
      },
      { type: "tool_result", tool_use_id: "t1" },
      {
        type: "tool_use",
        id: "t2",
        name: "Grep",
        input: { pattern: "waiting_for_input|WAITING_FOR_INPUT" },
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        metrics: { matchCount: 14 },
      },
      {
        type: "tool_use",
        id: "t3",
        name: "Glob",
        input: { pattern: "**/*.css" },
      },
      { type: "tool_result", tool_use_id: "t3", metrics: { fileCount: 3 } },
      {
        type: "tool_use",
        id: "t4",
        name: "Read",
        input: { file_path: `${WORKTREE}/src/app/globals.css` },
      },
      { type: "tool_result", tool_use_id: "t4", metrics: { lineCount: 6800 } },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;
