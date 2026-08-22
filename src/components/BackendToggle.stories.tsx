import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import BackendToggle from "./BackendToggle";
import ModelSelector from "./ModelSelector";
import ReasoningLevelSelector from "./ReasoningLevelSelector";
import { getEffortLevelsForBackend } from "@/lib/agent-backends/catalog";
import { backendFacetRefusal } from "@/lib/agent-backends/facet-gating";

const meta = {
  title: "Components/BackendToggle",
  component: BackendToggle,
  args: {
    value: "claude",
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
} satisfies Meta<typeof BackendToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default = {
  args: {},
} satisfies Story;

export const Codex = {
  args: {
    value: "codex",
  },
} satisfies Story;

export const Cursor = {
  args: {
    value: "cursor",
  },
} satisfies Story;

/**
 * A facet-gated surface (task, workflow role, collaboration) renders the
 * backends it cannot dispatch as visibly refused options carrying the reason,
 * rather than hiding them.
 */
export const OptionRefused = {
  args: {
    disabledReason: (entry) => backendFacetRefusal(entry, "tasks"),
  },
} satisfies Story;

export const ReadOnly = {
  args: {
    readOnly: true,
  },
} satisfies Story;

export const ReadOnlyCodex = {
  args: {
    value: "codex",
    readOnly: true,
  },
} satisfies Story;

export const ReadOnlyCursor = {
  args: {
    value: "cursor",
    readOnly: true,
  },
} satisfies Story;

export const Disabled = {
  args: {
    disabled: true,
  },
} satisfies Story;

/** Shows the backend toggle in context with model + effort selectors */
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
              placeholder="Send a prompt..."
              rows={2}
              readOnly
            />
            <div className="prompt-toolbar">
              <div className="prompt-toolbar-start">
                <Story />
                <ModelSelector value="opus" backend="claude" onChange={fn()} />
                <ReasoningLevelSelector
                  value="high"
                  availableLevels={getEffortLevelsForBackend("claude", "opus")}
                  onChange={fn()}
                />
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
