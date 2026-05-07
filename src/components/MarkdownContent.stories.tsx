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
$ bun run test
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

export const MermaidFlowchart = {
  args: {
    content: `## Architecture Diagram

\`\`\`mermaid
graph TB
    subgraph UI
        Panel[DevServerPanel]
        Hook[useDevServers hook]
    end

    subgraph API[API Routes]
        GetStatus[GET dev-servers]
        Start[POST start]
        Stop[POST stop]
    end

    subgraph Core[Domain Logic]
        Registry[DevServerRegistry]
        Spawner[ProcessSpawner]
    end

    Panel --> Hook
    Hook --> GetStatus
    Panel --> Start
    Panel --> Stop
    GetStatus --> Registry
    Start --> Registry
    Stop --> Registry
    Registry --> Spawner
\`\`\``,
  },
} satisfies Story;

export const MermaidSequence = {
  args: {
    content: `## Prompt Execution Flow

\`\`\`mermaid
sequenceDiagram
    participant UI as Browser
    participant API as API Route
    participant SDK as Claude SDK
    participant FS as Filesystem

    UI->>API: POST /prompt
    API->>SDK: query(prompt)
    loop Stream messages
        SDK-->>API: SDKMessage
        API->>FS: Append to transcript
    end
    SDK-->>API: Result
    API->>DB: Persist state
    API-->>UI: SSE status update
\`\`\``,
  },
} satisfies Story;

export const MermaidWithText = {
  args: {
    content: `# System Overview

The session manager handles **three key phases**:

\`\`\`mermaid
graph LR
    A[Create Session] --> B[Execute Prompts]
    B --> C[Review & Merge]
    style A fill:#0d3b66,stroke:#00e5ff
    style B fill:#0d3b66,stroke:#00e5ff
    style C fill:#0d3b66,stroke:#00e5ff
\`\`\`

Each session operates in its own **git worktree**, providing full isolation.

\`\`\`typescript
const session = await createSession("feature-auth");
\`\`\``,
  },
} satisfies Story;
