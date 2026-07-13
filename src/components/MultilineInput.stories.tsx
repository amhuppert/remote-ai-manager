"use client";

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { MultilineInput } from "./MultilineInput";

function MultilineInputDemo({
  disabled = false,
  readOnly = false,
}: {
  disabled?: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState("Describe the requested work.");

  return (
    <div className="flex w-[420px] flex-col gap-[var(--space-sm)]">
      <MultilineInput
        aria-label="Instructions"
        className="min-h-28 resize-y rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-surface)] px-[var(--space-md)] py-[var(--space-sm)] font-mono text-[0.82rem] text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--cyan)] focus:shadow-[0_0_0_3px_var(--cyan-glow)] disabled:cursor-not-allowed disabled:opacity-40"
        value={value}
        onValueChange={setValue}
        onPrimaryAction={fn()}
        placeholder="Enter instructions"
        disabled={disabled}
        readOnly={readOnly}
      />
      <p className="font-mono text-[0.7rem] text-[var(--text-tertiary)]">
        Enter adds a line. Ctrl+Enter triggers the primary action.
      </p>
    </div>
  );
}

const meta = {
  title: "Shared/MultilineInput",
  component: MultilineInputDemo,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof MultilineInputDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
};
