import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { Switch } from "./Switch";

const meta = {
  title: "UI/Switch",
  component: Switch,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  args: {
    "aria-label": "Toggle setting",
    onCheckedChange: fn(),
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Off — the default uncontrolled, unchecked state. */
export const Unchecked: Story = {
  args: { defaultChecked: false },
};

/** On — cyan glow track with the knob slid to the right. */
export const Checked: Story = {
  args: { defaultChecked: true },
};

/** Disabled, shown both off and on; pointer/keyboard interaction is suppressed. */
export const Disabled: Story = {
  render: (args) => (
    <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
      <Switch
        {...args}
        disabled
        defaultChecked={false}
        aria-label="Off disabled"
      />
      <Switch {...args} disabled defaultChecked aria-label="On disabled" />
    </div>
  ),
};

/** The three size variants (md / sm / compact), each shown off and on. */
export const Sizes: Story = {
  render: (args) => (
    <div style={{ display: "flex", gap: 32, alignItems: "center" }}>
      {(["md", "sm", "compact"] as const).map((size) => (
        <div
          key={size}
          style={{ display: "flex", gap: 12, alignItems: "center" }}
        >
          <Switch {...args} size={size} aria-label={`${size} off`} />
          <Switch
            {...args}
            size={size}
            defaultChecked
            aria-label={`${size} on`}
          />
        </div>
      ))}
    </div>
  ),
};

/** The small (compact) inline form, as used in info strips. */
export const Compact: Story = {
  args: { size: "compact", defaultChecked: true },
};

/** Green on-glow tone (e.g. the red-green TDD toggle). */
export const GreenTone: Story = {
  args: { tone: "green", defaultChecked: true },
};

/** Labelled usage: an external <label htmlFor> names the switch. Clicking the label toggles it. */
export const Labelled: Story = {
  render: (args) => (
    <label
      htmlFor="tdd-switch"
      style={{
        display: "inline-flex",
        gap: 8,
        alignItems: "center",
        cursor: "pointer",
        font: "var(--font-mono, monospace)",
        color: "var(--color-text-secondary)",
        fontSize: "0.8rem",
      }}
    >
      <Switch
        {...args}
        id="tdd-switch"
        tone="green"
        aria-label={undefined}
        defaultChecked
      />
      Red-green TDD
    </label>
  ),
};

/** Controlled: parent owns the checked state via checked + onCheckedChange. */
export const Controlled: Story = {
  render: (args) => {
    const [checked, setChecked] = useState(false);
    return (
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <Switch
          {...args}
          checked={checked}
          onCheckedChange={setChecked}
          aria-label="Controlled switch"
        />
        <span
          style={{
            font: "var(--font-mono, monospace)",
            fontSize: "0.75rem",
            color: "var(--color-text-tertiary)",
          }}
        >
          {checked ? "ON" : "OFF"}
        </span>
      </div>
    );
  },
};
