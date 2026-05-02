import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { MessageContentBlock } from "@/types";
import MessageContent from "./MessageContent";

const meta = {
  title: "Components/MessageContent",
  component: MessageContent,
} satisfies Meta<typeof MessageContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TextOnly = {
  args: {
    content: [
      {
        type: "text",
        text: "I'll help you refactor the authentication module.",
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const WithToolUse = {
  args: {
    content: [
      { type: "text", text: "Let me read the file first." },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/lib/auth.ts" },
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const MultipleBlocks = {
  args: {
    content: [
      {
        type: "text",
        text: "I'll update the session manager. Here's what I found:",
      },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/lib/sessions.ts" },
      },
      {
        type: "tool_result",
        tool_use_id: "tool_1",
        content: "file contents...",
      },
      {
        type: "text",
        text: "Now I'll make the changes:\n\n```typescript\nexport function createSession(name: string) {\n  // updated implementation\n}\n```",
      },
      {
        type: "tool_use",
        name: "Write",
        input: { file_path: "/src/lib/sessions.ts" },
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const ToolUseWithoutInput = {
  args: {
    content: [
      { type: "tool_use", name: "Bash" },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

// Tiny 1x1 PNG base64 for story demo
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

export const ImageOnly = {
  args: {
    content: [
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const TextAndImage = {
  args: {
    content: [
      { type: "text", text: "Here is a screenshot of the bug:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

export const MultipleImages = {
  args: {
    content: [
      { type: "text", text: "Compare these two UI states:" },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
      { type: "image", mediaType: "image/png", base64Data: TINY_PNG },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

/** Consecutive tool uses are grouped into a collapsible section */
export const GroupedToolUses = {
  args: {
    content: [
      {
        type: "text",
        text: "Let me find the relevant components and understand how statuses are styled.",
      },
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
        input: { pattern: 'status."indicator|status."dot' },
      },
      { type: "tool_result", tool_use_id: "t5" },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/app/globals.css" },
      },
      { type: "tool_result", tool_use_id: "t6" },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "amber|orange|\\.awaiting|\\.running" },
      },
      { type: "tool_result", tool_use_id: "t7" },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/components/UnifiedPanel.tsx" },
      },
      { type: "tool_result", tool_use_id: "t8" },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

/** Tool uses separated by text should NOT be grouped together */
export const SeparateGroupsByText = {
  args: {
    content: [
      { type: "text", text: "First, let me search for the file." },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "createSession" },
      },
      { type: "tool_result", tool_use_id: "t1" },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/lib/sessions.ts" },
      },
      { type: "tool_result", tool_use_id: "t2" },
      {
        type: "tool_use",
        name: "Glob",
        input: { pattern: "**/*session*.ts" },
      },
      { type: "tool_result", tool_use_id: "t3" },
      {
        type: "text",
        text: "Now I understand the structure. Let me make the changes.",
      },
      {
        type: "tool_use",
        name: "Edit",
        input: { file_path: "/src/lib/sessions.ts" },
      },
      { type: "tool_result", tool_use_id: "t4" },
      {
        type: "tool_use",
        name: "Write",
        input: { file_path: "/src/lib/sessions.test.ts" },
      },
      { type: "tool_result", tool_use_id: "t5" },
      {
        type: "text",
        text: "Done! The session creation logic has been updated.",
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

/** A single tool use should NOT be grouped (rendered inline) */
export const SingleToolUseNoGroup = {
  args: {
    content: [
      { type: "text", text: "Let me check that file." },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "/src/lib/config.ts" },
      },
      { type: "tool_result", tool_use_id: "t1" },
      { type: "text", text: "The config looks correct." },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;

const WORKTREE = "/home/alex/github/remote-ai-manager/.worktrees/feature-x";

/** Tool uses paired with results showing line counts, match counts, and errors */
export const WithResultMetrics = {
  args: {
    worktreePath: WORKTREE,
    content: [
      { type: "text", text: "Let me investigate the codebase." },
      {
        type: "tool_use",
        id: "t1",
        name: "Read",
        input: { file_path: `${WORKTREE}/src/lib/auth.ts` },
      },
      {
        type: "tool_result",
        tool_use_id: "t1",
        content: "...",
        metrics: { lineCount: 234 },
      },
      { type: "text", text: "Let me search for usages and run the tests." },
      {
        type: "tool_use",
        id: "t2",
        name: "Grep",
        input: { pattern: "createSession" },
      },
      {
        type: "tool_result",
        tool_use_id: "t2",
        metrics: { matchCount: 12 },
      },
      {
        type: "tool_use",
        id: "t3",
        name: "Bash",
        input: { command: "bun test", description: "Run tests" },
      },
      {
        type: "tool_result",
        tool_use_id: "t3",
        content: "FAIL src/lib/auth.test.ts",
        isError: true,
        metrics: { exitCode: 1 },
      },
    ] satisfies MessageContentBlock[],
  },
} satisfies Story;
