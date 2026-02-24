import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MessageEditor from "./MessageEditor";

const meta = {
  title: "Components/MessageEditor",
  component: MessageEditor,
  args: {
    onSave: fn(),
    onCancel: fn(),
  },
  decorators: [
    (Story) => (
      <div
        className="message user editing"
        style={{
          position: "relative",
          maxWidth: "600px",
          background: "var(--bg-surface)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          padding: "var(--space-md)",
        }}
      >
        <div className="message-role">You</div>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof MessageEditor>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {
    originalText:
      "Can you refactor the authentication module to use JWT tokens instead of session cookies?",
    messageIndex: 2,
  },
} satisfies Story;

export const LongMessage = {
  args: {
    originalText: `I need you to do several things:

1. Refactor the authentication module to use JWT tokens
2. Update the middleware to validate tokens on each request
3. Add refresh token rotation
4. Update the login and logout endpoints
5. Write tests for the new auth flow

Make sure to keep backwards compatibility with existing sessions during the migration period.`,
    messageIndex: 4,
  },
} satisfies Story;

export const ShortMessage = {
  args: {
    originalText: "Fix the bug",
    messageIndex: 0,
  },
} satisfies Story;

export const Saving = {
  args: {
    originalText: "Update the config file",
    messageIndex: 6,
    saving: true,
  },
} satisfies Story;

export const MobileWidth = {
  args: {
    originalText: "Refactor the auth module to use JWT tokens",
    messageIndex: 2,
  },
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
