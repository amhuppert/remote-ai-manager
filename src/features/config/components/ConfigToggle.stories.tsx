import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { ConfigToggle } from "./ConfigToggle";

// Pins the appearance after ConfigToggle was rebased onto the shared ui/Switch
// primitive: the on-state is the primitive's cyan-glow track (bg-cyan-glow, 8px
// glow) rather than the old solid-cyan 12px-glow fill. This visual delta is the
// approved consequence of consuming the canonical Switch recipe. The field's
// descriptive label names the switch (aria-label); the whole row (switch +
// ON/OFF caption) is one click target via the wrapping <label>.
const meta = {
  title: "Config/ConfigToggle",
  component: ConfigToggle,
  parameters: { a11y: { test: "error" }, layout: "centered" },
  args: { label: "Tailscale enabled", onChange: fn() },
} satisfies Meta<typeof ConfigToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

/** On — the shared cyan-glow track with the ON caption. */
export const On = {
  args: { value: true },
} satisfies Story;

/** Off — raised track, OFF caption. */
export const Off = {
  args: { value: false },
} satisfies Story;

/** Disabled, shown both on and off; pointer/keyboard interaction is suppressed. */
export const Disabled = {
  args: { value: false, disabled: true },
  render: (args) => (
    <div className="flex items-center gap-xl">
      <ConfigToggle {...args} value={false} label="Off disabled" />
      <ConfigToggle {...args} value label="On disabled" />
    </div>
  ),
} satisfies Story;

/** Controlled: clicking anywhere on the row (switch or caption) toggles it. */
export const Interactive = {
  args: { value: false },
  render: (args) => {
    const [value, setValue] = useState(false);
    return <ConfigToggle {...args} value={value} onChange={setValue} />;
  },
} satisfies Story;
