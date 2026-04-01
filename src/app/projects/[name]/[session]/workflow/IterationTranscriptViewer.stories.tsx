import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import "@/components/workflow-graph/workflow-graph.css";
import type { TranscriptMessage } from "@/types";
import IterationTranscriptViewer from "./IterationTranscriptViewer";

const sampleMessages: TranscriptMessage[] = [
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "Implement the authentication middleware using JWT tokens. The middleware should validate tokens on all protected routes and extract user information.",
      },
    ],
    timestamp: "2026-03-30T09:55:00Z",
    model: "opus",
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll implement the JWT authentication middleware. Let me start by examining the existing route structure and dependencies.",
      },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "src/lib/routes.ts" },
      },
      {
        type: "tool_use",
        name: "Read",
        input: { file_path: "package.json" },
      },
      {
        type: "text",
        text: 'I can see the route structure. Now let me create the authentication middleware.\n\nThe middleware will:\n1. Extract the Bearer token from the Authorization header\n2. Verify the JWT signature using `jsonwebtoken`\n3. Attach the decoded user payload to the request\n4. Return 401 for missing or invalid tokens\n\n```typescript\nimport jwt from "jsonwebtoken";\n\nexport function authMiddleware(req, res, next) {\n  const token = req.headers.authorization?.split(" ")[1];\n  if (!token) return res.status(401).json({ error: "No token" });\n  // ... verify token\n}\n```',
      },
    ],
    timestamp: "2026-03-30T09:55:05Z",
    model: "opus",
  },
  {
    role: "user",
    content: [
      {
        type: "text",
        text: "Good, now add rate limiting to the auth endpoints to prevent brute force attacks.",
      },
    ],
    timestamp: "2026-03-30T10:05:00Z",
  },
  {
    role: "assistant",
    content: [
      {
        type: "text",
        text: "I'll add rate limiting to protect the auth endpoints. Let me check if there's an existing rate limiting solution in the project.",
      },
      {
        type: "tool_use",
        name: "Grep",
        input: { pattern: "rate.limit", path: "src/" },
      },
      {
        type: "tool_use",
        name: "Write",
        input: {
          file_path: "src/middleware/rate-limiter.ts",
          content: "// rate limiter implementation",
        },
      },
      {
        type: "text",
        text: "Rate limiting has been added with a sliding window approach:\n- **Login endpoint**: 5 attempts per 15 minutes per IP\n- **Token refresh**: 10 requests per minute\n- **Password reset**: 3 attempts per hour\n\nThe rate limiter uses an in-memory store with automatic cleanup of expired entries.",
      },
    ],
    timestamp: "2026-03-30T10:05:10Z",
    model: "opus",
  },
];

/**
 * Decorator that intercepts fetch calls for the conversation messages API
 * and returns sample transcript data.
 */
function withMockMessages(messages: TranscriptMessage[]) {
  return function MockFetchDecorator(Story: React.ComponentType) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/conversations/") && url.includes("/messages")) {
        return new Response(JSON.stringify(messages), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return originalFetch(input, init);
    };

    return <Story />;
  };
}

const meta = {
  title: "Workflow/IterationTranscriptViewer",
  component: IterationTranscriptViewer,
  parameters: {
    layout: "fullscreen",
    backgrounds: { default: "dark" },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: "100%",
          maxWidth: 800,
          height: 700,
          margin: "24px auto",
          display: "flex",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          overflow: "hidden",
        }}
      >
        <Story />
      </div>
    ),
  ],
  args: {
    projectName: "my-project",
    sessionName: "auth-implementation",
    conversationId: "conv-2",
    contextTitle: "API Integration",
    taskTitle: "Auth middleware",
    isLive: false,
    onClose: fn(),
  },
} satisfies Meta<typeof IterationTranscriptViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const CompletedIteration: Story = {
  decorators: [withMockMessages(sampleMessages)],
};

export const LiveIteration: Story = {
  args: {
    isLive: true,
  },
  decorators: [withMockMessages(sampleMessages)],
};

export const EmptyCompleted: Story = {
  name: "Empty (Completed)",
  args: {
    isLive: false,
  },
  decorators: [withMockMessages([])],
};

export const EmptyLive: Story = {
  name: "Empty (Live — Waiting)",
  args: {
    isLive: true,
  },
  decorators: [withMockMessages([])],
};

export const SingleMessage: Story = {
  decorators: [
    withMockMessages([
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Starting implementation of the database migration for the users table. This migration will create the base schema with id, email, name, and timestamp columns.",
          },
          {
            type: "tool_use",
            name: "Write",
            input: {
              file_path: "migrations/001_create_users.sql",
              content: "CREATE TABLE users (...)",
            },
          },
          {
            type: "text",
            text: "Migration file created. Running the migration now.",
          },
        ],
        timestamp: "2026-03-30T09:20:00Z",
        model: "sonnet",
      },
    ]),
  ],
};
