import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { RadioGroup, RadioGroupItem, RadioGroupOption } from "./RadioGroup";

const meta = {
  title: "UI/RadioGroup",
  component: RadioGroup,
  parameters: {
    // Radix drives the WAI-ARIA radio-group pattern (role=radiogroup/radio,
    // roving tabindex, arrow-key navigation, single-selection invariant); a11y
    // violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof RadioGroup>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Labelled radio options with descriptions (the CollabConfigRow shape). */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState("fast");
    return (
      <RadioGroup
        aria-label="Creation mode"
        value={value}
        onValueChange={setValue}
      >
        <RadioGroupOption
          value="fast"
          label="Fast"
          description="Minimal review — spawn and go."
        />
        <RadioGroupOption
          value="focus"
          label="Focus"
          description="Plan, then implement with checkpoints."
        />
        <RadioGroupOption
          value="manual"
          label="Manual"
          description="No automation; you drive every step."
        />
      </RadioGroup>
    );
  },
};

/** Bare circular controls with external labels (compact rows). */
export const BareItems: Story = {
  render: () => {
    const [value, setValue] = useState("claude");
    return (
      <RadioGroup aria-label="Backend" value={value} onValueChange={setValue}>
        {["claude", "codex", "gemini"].map((b) => (
          <label
            key={b}
            className="flex cursor-pointer items-center gap-sm font-mono text-[0.78rem] text-text-primary"
          >
            <RadioGroupItem value={b} />
            {b}
          </label>
        ))}
      </RadioGroup>
    );
  },
};

/** A disabled option inside an otherwise interactive group. */
export const WithDisabledOption: Story = {
  render: () => {
    const [value, setValue] = useState("medium");
    return (
      <RadioGroup aria-label="Effort" value={value} onValueChange={setValue}>
        <RadioGroupOption value="low" label="Low" />
        <RadioGroupOption value="medium" label="Medium" />
        <RadioGroupOption
          value="max"
          label="Max"
          description="Unavailable on this plan"
          disabled
        />
      </RadioGroup>
    );
  },
};
