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
      { type: "text", text: "I'll help you refactor the authentication module." },
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
