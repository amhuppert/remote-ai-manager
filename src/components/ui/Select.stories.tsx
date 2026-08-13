import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectLabel,
  SelectSeparator,
} from "./Select";

const meta = {
  title: "UI/Select",
  component: Select,
  parameters: {
    // Radix drives the WAI-ARIA listbox / select-only combobox pattern (roving
    // focus, type-ahead, arrow/Home/End/Escape, role/aria wiring); a11y
    // violations fail the Storybook test project.
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof Select>;

export default meta;
type Story = StoryObj<typeof meta>;

const MODELS = [
  { id: "fable", label: "Fable", desc: "Most capable" },
  { id: "opus", label: "Opus", desc: "Highly capable" },
  { id: "sonnet", label: "Sonnet", desc: "Balanced" },
  { id: "haiku", label: "Haiku", desc: "Fastest" },
];

/** Single-value model picker with right-aligned descriptions (the ModelSelector shape). */
export const Default: Story = {
  render: () => {
    const [value, setValue] = useState("opus");
    return (
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id} description={m.desc}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  },
};

/** Empty initial value shows the muted placeholder in the trigger. */
export const Placeholder: Story = {
  render: () => (
    <Select>
      <SelectTrigger aria-label="Model">
        <SelectValue placeholder="Select a model" />
      </SelectTrigger>
      <SelectContent>
        {MODELS.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  ),
};

/** Grouped options with section labels and a separator. */
export const Grouped: Story = {
  render: () => {
    const [value, setValue] = useState("opus");
    return (
      <Select value={value} onValueChange={setValue}>
        <SelectTrigger aria-label="Agent model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Claude</SelectLabel>
            <SelectItem value="opus">Opus</SelectItem>
            <SelectItem value="sonnet">Sonnet</SelectItem>
            <SelectItem value="haiku">Haiku</SelectItem>
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel>Codex</SelectLabel>
            <SelectItem value="gpt-5.5">GPT-5.5</SelectItem>
            <SelectItem value="gpt-5.4">GPT-5.4</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  },
};

/** A disabled option and a fully disabled trigger. */
export const DisabledStates: Story = {
  render: () => {
    const [value, setValue] = useState("opus");
    return (
      <div className="flex items-center gap-[12px]">
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger aria-label="Model">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opus">Opus</SelectItem>
            <SelectItem value="haiku">Haiku</SelectItem>
            <SelectItem value="sonnet" disabled>
              Sonnet (unavailable)
            </SelectItem>
          </SelectContent>
        </Select>
        <Select value="opus" disabled>
          <SelectTrigger aria-label="Model (disabled)">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="opus">Opus</SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  },
};

/** Opens upward (`side="top"`) — the position the composer toolbar pickers use. */
export const OpenUpward: Story = {
  render: () => {
    const [value, setValue] = useState("max");
    return (
      <div className="flex h-[260px] items-end">
        <Select value={value} onValueChange={setValue}>
          <SelectTrigger aria-label="Reasoning effort">
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="top">
            <SelectItem value="low" description="Minimal">
              Low
            </SelectItem>
            <SelectItem value="medium" description="Moderate">
              Medium
            </SelectItem>
            <SelectItem value="high" description="Default">
              High
            </SelectItem>
            <SelectItem value="max" description="Maximum">
              Max
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    );
  },
};

/** Opened on mount so the listbox surface is reviewable without interaction. */
export const StaticOpen: Story = {
  render: () => (
    <div className="flex h-[280px] items-start justify-center pt-[16px]">
      <Select defaultOpen defaultValue="opus">
        <SelectTrigger aria-label="Model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {MODELS.map((m) => (
            <SelectItem key={m.id} value={m.id} description={m.desc}>
              {m.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ),
};

/** Elevated content for a select portaled from inside another popover. */
export const NestedPopoverLayer: Story = {
  render: () => (
    <div className="flex h-[280px] items-start justify-center pt-[16px]">
      <Select defaultOpen defaultValue="opus">
        <SelectTrigger aria-label="Nested model">
          <SelectValue />
        </SelectTrigger>
        <SelectContent contentLayer="popover">
          {MODELS.map((model) => (
            <SelectItem
              key={model.id}
              value={model.id}
              description={model.desc}
            >
              {model.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  ),
};
