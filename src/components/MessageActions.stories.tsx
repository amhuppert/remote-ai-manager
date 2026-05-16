import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import MessageActions from "./MessageActions";

const meta = {
  title: "Components/MessageActions",
  component: MessageActions,
  args: {
    messageIndex: 2,
    content: [
      {
        type: "text",
        text: "Can you refactor the authentication module to use JWT tokens instead of session cookies? Make sure to update the middleware as well.",
      },
    ],
    onFork: fn(),
  },
  decorators: [
    (Story) => (
      <div
        className="message user"
        style={{
          position: "relative",
          padding: "0",
          maxWidth: "600px",
        }}
      >
        <div className="message-role">You</div>
        <div className="message-content">
          <p>
            Can you refactor the authentication module to use JWT tokens instead
            of session cookies? Make sure to update the middleware as well.
          </p>
        </div>
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const MobileWidth = {
  args: {},
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
} satisfies Story;
