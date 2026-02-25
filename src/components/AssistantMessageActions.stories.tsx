import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import AssistantMessageActions from "./AssistantMessageActions";

const meta = {
  title: "Components/AssistantMessageActions",
  component: AssistantMessageActions,
  decorators: [
    (Story) => (
      <div
        className="message assistant"
        style={{
          position: "relative",
          padding: "0",
          maxWidth: "600px",
        }}
      >
        <div className="message-role">Claude</div>
        <div className="message-content">
          <p>
            I&apos;ve refactored the authentication module to use JWT tokens.
            Here&apos;s what changed:
          </p>
          <pre>
            <code>{`const token = jwt.sign(payload, secret);`}</code>
          </pre>
        </div>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof AssistantMessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    content: [
      {
        type: "text" as const,
        text: "I've refactored the authentication module to use JWT tokens.\n\n```typescript\nconst token = jwt.sign(payload, secret);\n```\n\nThe middleware has been updated as well.",
      },
    ],
  },
} satisfies Story;

export const MultipleTextBlocks = {
  args: {
    content: [
      {
        type: "text" as const,
        text: "First, I analyzed the codebase structure.",
      },
      {
        type: "tool_use" as const,
        name: "Read",
        input: { file_path: "/src/auth.ts" },
      },
      {
        type: "text" as const,
        text: "Then I made the following changes:\n\n```typescript\nexport function authenticate(token: string) {\n  return jwt.verify(token, process.env.SECRET!);\n}\n```",
      },
    ],
  },
} satisfies Story;
