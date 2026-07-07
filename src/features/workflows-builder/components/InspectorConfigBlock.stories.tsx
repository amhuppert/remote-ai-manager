import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import InspectorConfigBlock from "./InspectorConfigBlock";

function ReadOnlyBody(): React.JSX.Element {
  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Backend
      </label>
      <select className="form-input" defaultValue="claude">
        <option value="claude">Claude</option>
        <option value="codex">Codex</option>
      </select>
      <label
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Model
      </label>
      <select className="form-input" defaultValue="sonnet">
        <option value="sonnet">Sonnet</option>
        <option value="opus">Opus</option>
      </select>
      <label
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: "0.72rem",
          color: "var(--text-secondary)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        Reasoning effort
      </label>
      <select className="form-input" defaultValue="high">
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
  );
}

const meta = {
  title: "Workflows/InspectorConfigBlock",
  component: InspectorConfigBlock,
  args: {
    label: "Implementer",
    summary: "claude · sonnet · high",
    source: "global",
    onOverride: fn(),
    onReset: fn(),
    onToggleDisabled: fn(),
    children: <ReadOnlyBody />,
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 420,
          padding: 16,
          background: "var(--bg-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof InspectorConfigBlock>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InheritedFromGlobal = {
  args: {
    source: "global",
  },
} satisfies Story;

export const InheritedFromWorkflow = {
  args: {
    source: "workflow",
  },
} satisfies Story;

export const Overridden = {
  args: {
    source: "context-override",
    defaultOpen: true,
  },
} satisfies Story;

export const ValidatorDisabled = {
  args: {
    label: "Context validator",
    summary: "claude · sonnet · medium",
    source: "disabled",
  },
} satisfies Story;

export const LongSummary = {
  args: {
    source: "global",
    summary:
      "claude · sonnet · high · continuity:on · limit:auto · failures:3 · mutability:strict",
  },
} satisfies Story;

export const GateWithSwitch = {
  args: {
    label: "Script validator",
    summary: undefined,
    source: "global",
    collapsible: false,
    description: "Runs the project's preMergeCommand before agent validation.",
    headerSwitch: {
      checked: true,
      onCheckedChange: fn(),
      ariaLabel: "Script validator",
    },
    children: undefined,
  },
} satisfies Story;

export const GateOverriddenAmber = {
  args: {
    label: "Human approval gate",
    summary: undefined,
    source: "context-override",
    collapsible: false,
    tone: "amber",
    description:
      "After all validators pass, this context parks for your review before merge.",
    headerSwitch: {
      checked: true,
      onCheckedChange: fn(),
      ariaLabel: "Human approval gate",
    },
    children: undefined,
  },
} satisfies Story;

export const MobileViewport = {
  args: {
    source: "context-override",
    defaultOpen: true,
  },
  parameters: {
    viewport: {
      defaultViewport: "mobile1",
    },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          width: 375,
          padding: 12,
          background: "var(--bg-base)",
        }}
      >
        <Story />
      </div>
    ),
  ],
} satisfies Story;
