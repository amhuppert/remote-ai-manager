import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import TddToggle from "./TddToggle";

const meta = {
  title: "Components/TddToggle",
  component: TddToggle,
  args: {
    enabled: true,
    onChange: fn(),
    disabled: false,
    compact: false,
  },
  decorators: [
    (Story) => (
      <div style={{ padding: "2rem", background: "var(--bg-void, #06090f)" }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TddToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

// --- Static stories ---

export const OnDefault: Story = {
  args: { enabled: true },
};

export const OffDefault: Story = {
  args: { enabled: false },
};

export const OnCompact: Story = {
  args: { enabled: true, compact: true },
};

export const OffCompact: Story = {
  args: { enabled: false, compact: true },
};

export const Disabled: Story = {
  args: { enabled: true, disabled: true },
};

export const DisabledCompact: Story = {
  args: { enabled: false, disabled: true, compact: true },
};

// --- Interactive story ---

function InteractiveToggle() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.65rem",
            color: "var(--text-tertiary, #4d5a72)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.5rem",
          }}
        >
          Modal variant
        </div>
        <TddToggle enabled={enabled} onChange={setEnabled} />
      </div>
      <div>
        <div
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: "0.65rem",
            color: "var(--text-tertiary, #4d5a72)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.5rem",
          }}
        >
          Compact variant (info strip / table)
        </div>
        <TddToggle enabled={enabled} onChange={setEnabled} compact />
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveToggle />,
};

// --- Context story: inside a mock modal ---

function MockModal() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div
      style={{
        background: "var(--bg-surface, #111825)",
        borderRadius: "var(--radius-lg, 10px)",
        border: "1px solid var(--border-subtle, #1a2338)",
        padding: "1.5rem",
        maxWidth: 420,
        fontFamily: "var(--font-mono, monospace)",
      }}
    >
      <div
        style={{
          fontFamily: "var(--font-display, sans-serif)",
          fontWeight: 700,
          fontSize: "1.2rem",
          color: "var(--text-primary, #dce2f0)",
          marginBottom: "1rem",
        }}
      >
        New Session
      </div>
      <label
        style={{
          display: "block",
          fontSize: "0.72rem",
          fontWeight: 600,
          color: "var(--text-secondary, #7b899f)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          marginBottom: "0.5rem",
        }}
      >
        Session name
      </label>
      <input
        type="text"
        placeholder="e.g. Copy To Clipboard"
        style={{
          width: "100%",
          padding: "10px 14px",
          background: "var(--bg-base, #0a0f1a)",
          border: "1px solid var(--border-default, #253045)",
          borderRadius: "var(--radius-md, 6px)",
          color: "var(--text-primary, #dce2f0)",
          fontFamily: "var(--font-mono, monospace)",
          fontSize: "0.85rem",
          boxSizing: "border-box",
        }}
      />
      <div
        style={{
          fontSize: "0.68rem",
          color: "var(--text-tertiary, #4d5a72)",
          marginTop: "0.25rem",
          marginBottom: "1rem",
        }}
      >
        Branch name will be derived from the session name
      </div>
      <TddToggle enabled={enabled} onChange={setEnabled} />
    </div>
  );
}

export const InModal: Story = {
  render: () => <MockModal />,
};

// --- Context story: inside a mock info strip ---

function MockInfoStrip() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div
      style={{
        background: "var(--bg-surface, #111825)",
        borderRadius: "var(--radius-sm, 4px)",
        border: "1px solid var(--border-subtle, #1a2338)",
        padding: "4px 12px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
        fontFamily: "var(--font-mono, monospace)",
        fontSize: "0.58rem",
        fontWeight: 600,
        color: "var(--text-tertiary, #4d5a72)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
      }}
    >
      <span style={{ color: "var(--text-secondary, #7b899f)" }}>
        csm/fix-login-bug
      </span>
      <span style={{ opacity: 0.3 }}>|</span>
      <span>Created 2h ago</span>
      <span style={{ opacity: 0.3 }}>|</span>
      <span>3 prompts</span>
      <span style={{ opacity: 0.3 }}>|</span>
      <TddToggle enabled={enabled} onChange={setEnabled} compact />
    </div>
  );
}

export const InInfoStrip: Story = {
  render: () => <MockInfoStrip />,
};
