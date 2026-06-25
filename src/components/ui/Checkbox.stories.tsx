import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { Checkbox, CheckboxField } from "./Checkbox";

const meta = {
  title: "UI/Checkbox",
  component: Checkbox,
  parameters: {
    // Radix drives the WAI-ARIA checkbox pattern (role=checkbox, aria-checked
    // incl. mixed, Space-to-toggle, label association); a11y violations fail the
    // Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Checkbox>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The three visual states side by side: unchecked, checked, indeterminate. */
export const States: Story = {
  render: () => (
    <div className="flex items-center gap-[20px]">
      <Checkbox aria-label="Unchecked" checked={false} />
      <Checkbox aria-label="Checked" checked />
      <Checkbox aria-label="Indeterminate" checked="indeterminate" />
    </div>
  ),
};

/** Controlled box that toggles on click / Space. */
export const Interactive: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return (
      <Checkbox
        aria-label="Toggle me"
        checked={checked}
        onCheckedChange={(next) => setChecked(next === true)}
      />
    );
  },
};

/** Disabled in both unchecked and checked states. */
export const Disabled: Story = {
  render: () => (
    <div className="flex items-center gap-[20px]">
      <Checkbox aria-label="Disabled unchecked" disabled />
      <Checkbox aria-label="Disabled checked" disabled checked />
    </div>
  ),
};

/** Labelled convenience with a description (the form-field shape). */
export const WithLabelAndDescription: Story = {
  render: () => {
    const [checked, setChecked] = useState(true);
    return (
      <CheckboxField
        checked={checked}
        onCheckedChange={(next) => setChecked(next === true)}
        label="Run pre-merge validation"
        description="Block the merge if the validation command exits non-zero."
      />
    );
  },
};

/** A dense vertical stack of labelled checkboxes (a settings list). */
export const Group: Story = {
  render: () => {
    const [state, setState] = useState({
      transcripts: true,
      diffs: true,
      notifications: false,
    });
    return (
      <div className="flex flex-col gap-md">
        <CheckboxField
          checked={state.transcripts}
          onCheckedChange={(v) =>
            setState((s) => ({ ...s, transcripts: v === true }))
          }
          label="Transcripts"
        />
        <CheckboxField
          checked={state.diffs}
          onCheckedChange={(v) =>
            setState((s) => ({ ...s, diffs: v === true }))
          }
          label="Diffs"
        />
        <CheckboxField
          checked={state.notifications}
          onCheckedChange={(v) =>
            setState((s) => ({ ...s, notifications: v === true }))
          }
          label="Notifications"
        />
      </div>
    );
  },
};
