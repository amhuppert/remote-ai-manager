import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import MarkdownContent from "./MarkdownContent";

const meta = {
  title: "Components/MarkdownContent",
  component: MarkdownContent,
} satisfies Meta<typeof MarkdownContent>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Paragraph = {
  args: {
    content:
      "This is a simple paragraph with **bold**, *italic*, and `inline code`.",
  },
} satisfies Story;

export const CodeBlock = {
  args: {
    content: `Here's a TypeScript example:

\`\`\`typescript
interface SessionState {
  sessionName: string;
  status: "idle" | "ready" | "running";
  promptCount: number;
}

function createSession(name: string): SessionState {
  return { sessionName: name, status: "idle", promptCount: 0 };
}
\`\`\``,
  },
} satisfies Story;

export const MixedContent = {
  args: {
    content: `## Session Summary

The session completed **3 tasks** successfully:

1. Refactored the authentication module
2. Added unit tests for \`SessionManager\`
3. Fixed a race condition in the prompt queue

\`\`\`bash
$ npm run test:run
✓ 42 tests passed
\`\`\`

> Note: The race condition was caused by concurrent \`execFile\` calls.`,
  },
} satisfies Story;

export const LongContent = {
  args: {
    content: `# Architecture Overview

## Data Flow

The application follows a **server-rendered** pattern with API routes acting as the backend.

### Key Components

- **Project Discovery** scans a base directory for git repos
- **Session Manager** creates and tracks worktree-backed sessions
- **Prompt Runner** executes Claude CLI as a subprocess

### State Management

State is persisted as JSON on the filesystem. Each write uses an atomic pattern:

\`\`\`typescript
// Write to temp file, then rename for crash safety
await writeFile(tmpPath, JSON.stringify(state, null, 2));
await rename(tmpPath, statePath);
\`\`\`

This ensures the state file is never partially written.`,
  },
} satisfies Story;
