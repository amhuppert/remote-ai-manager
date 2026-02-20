import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ModelSelector from "./ModelSelector";

const meta = {
  title: "Components/ModelSelector",
  component: ModelSelector,
  args: {
    value: "sonnet",
    onChange: fn(),
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-end",
          minHeight: 200,
          padding: 32,
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ModelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Opus = {
  args: {
    value: "opus",
  },
} satisfies Story;

export const Haiku = {
  args: {
    value: "haiku",
  },
} satisfies Story;

export const Disabled = {
  args: {
    disabled: true,
  },
} satisfies Story;

export const InPromptArea = {
  decorators: [
    (Story) => (
      <div
        style={{
          maxWidth: 600,
          margin: "0 auto",
        }}
      >
        <div className="prompt-input-area">
          <div className="prompt-input-wrapper">
            <textarea
              className="prompt-textarea"
              placeholder="Send a prompt to Claude..."
              rows={2}
              readOnly
            />
            <div className="prompt-input-actions">
              <Story />
              <button
                className="send-btn"
                style={{ cursor: "default" }}
              >
                &#x25B6;
              </button>
            </div>
          </div>
        </div>
      </div>
    ),
  ],
} satisfies Story;
