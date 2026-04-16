import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import ReasoningLevelSelector from "./ReasoningLevelSelector";
import ModelSelector from "./ModelSelector";

const meta = {
  title: "Components/ReasoningLevelSelector",
  component: ReasoningLevelSelector,
  args: {
    value: "high",
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
} satisfies Meta<typeof ReasoningLevelSelector>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Low = {
  args: {
    value: "low",
  },
} satisfies Story;

export const Medium = {
  args: {
    value: "medium",
  },
} satisfies Story;

export const Disabled = {
  args: {
    disabled: true,
    disabledTooltip: "Reasoning effort not supported by Sonnet",
  },
} satisfies Story;

export const ClaudeOpus = {
  args: {
    value: "high",
    availableLevels: ["low", "medium", "high", "xhigh", "max"],
  },
} satisfies Story;

export const ClaudeOpusXHigh = {
  args: {
    value: "xhigh",
    availableLevels: ["low", "medium", "high", "xhigh", "max"],
  },
} satisfies Story;

export const ClaudeSonnet = {
  args: {
    value: "high",
    availableLevels: ["low", "medium", "high"],
  },
} satisfies Story;

export const ClaudeHaiku = {
  args: {
    disabled: true,
    disabledTooltip: "Not available for Haiku",
  },
} satisfies Story;

export const CodexDefault = {
  args: {
    value: "high",
    availableLevels: ["low", "medium", "high", "xhigh"],
  },
} satisfies Story;

export const CodexXHigh = {
  args: {
    value: "xhigh",
    availableLevels: ["low", "medium", "high", "xhigh"],
  },
} satisfies Story;

export const CodexAllLevels = {
  args: {
    value: "medium",
    availableLevels: ["minimal", "low", "medium", "high", "xhigh"],
  },
} satisfies Story;

/** Shows both selectors side-by-side in the prompt toolbar, as they appear in the actual UI */
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
            <div className="prompt-toolbar">
              <div className="prompt-toolbar-start">
                <ModelSelector value="opus" onChange={fn()} />
                <Story />
              </div>
              <div className="prompt-toolbar-end">
                <button className="send-btn" style={{ cursor: "default" }}>
                  &#x25B6;
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    ),
  ],
} satisfies Story;

/** Shows the message metadata treatment: model + effort next to "Claude" role label */
export const MessageMetadataDemo = {
  decorators: [
    () => (
      <div
        style={{
          maxWidth: 600,
          margin: "0 auto",
          padding: 32,
        }}
      >
        <div className="conversation" style={{ gap: "var(--space-lg)" }}>
          {/* Assistant message with model + effort */}
          <div className="message assistant">
            <div className="message-role">
              Claude
              <span className="message-meta">
                <span className="message-meta-sep">&middot;</span>
                <span className="message-meta-model">Opus</span>
                <span className="message-meta-sep">&middot;</span>
                <span className="message-meta-effort rainbow-text">High</span>
              </span>
            </div>
            <div className="message-content">
              This response was generated with Opus at High reasoning effort.
            </div>
          </div>

          {/* User message — no metadata */}
          <div className="message user">
            <div className="message-role">You</div>
            <div className="message-content">
              Can you try a different approach?
            </div>
          </div>

          {/* Codex message with XHigh rainbow effect */}
          <div className="message assistant">
            <div className="message-role">
              Codex
              <span className="message-meta">
                <span className="message-meta-sep">&middot;</span>
                <span className="message-meta-model">GPT-5.4</span>
                <span className="message-meta-sep">&middot;</span>
                <span className="message-meta-effort rainbow-text">xhigh</span>
              </span>
            </div>
            <div className="message-content">
              This response was generated with GPT-5.4 at XHigh reasoning effort
              — same rainbow effect as Claude&apos;s Max.
            </div>
          </div>

          {/* Assistant message with different model + effort */}
          <div className="message assistant">
            <div className="message-role">
              Claude
              <span className="message-meta">
                <span className="message-meta-sep">&middot;</span>
                <span className="message-meta-model">Sonnet</span>
              </span>
            </div>
            <div className="message-content">
              This response used Sonnet, which does not support reasoning effort
              — so no effort label is shown.
            </div>
          </div>
        </div>
      </div>
    ),
  ],
} satisfies Story;
