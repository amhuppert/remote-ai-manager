"use client";

import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import BackendToggle from "@/components/BackendToggle";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import CodexSpeedToggle from "./CodexSpeedToggle";

const meta = {
  title: "Session/Prompt/CodexSpeedToggle",
  component: CodexSpeedToggle,
  args: {
    fastMode: false,
    onFastModeChange: fn(),
  },
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
} satisfies Meta<typeof CodexSpeedToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

function InteractiveToggle({
  initialFastMode,
  disabled = false,
  presentation = "compact",
}: {
  initialFastMode: boolean;
  disabled?: boolean;
  presentation?: "compact" | "fullWidth";
}) {
  const [fastMode, setFastMode] = useState(initialFastMode);

  return (
    <CodexSpeedToggle
      fastMode={fastMode}
      onFastModeChange={setFastMode}
      disabled={disabled}
      presentation={presentation}
    />
  );
}

export const Standard: Story = {
  render: () => <InteractiveToggle initialFastMode={false} />,
};

export const Fast: Story = {
  render: () => <InteractiveToggle initialFastMode />,
};

export const Disabled: Story = {
  render: () => <InteractiveToggle initialFastMode disabled />,
};

export const MobileFullWidth: Story = {
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
  decorators: [
    (Story) => (
      <div className="w-[358px] bg-bg-surface p-md">
        <div className="mb-xs px-sm font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Speed
        </div>
        <Story />
      </div>
    ),
  ],
  render: () => <InteractiveToggle initialFastMode presentation="fullWidth" />,
};

export const InDesktopPromptToolbar: Story = {
  decorators: [
    (Story) => (
      <div className="flex items-center gap-sm border border-solid border-border-subtle bg-bg-base p-md">
        <BackendToggle value="codex" onChange={fn()} />
        <ModelSelector value="gpt-5.5" backend="codex" onChange={fn()} />
        <ReasoningLevelSelector
          value="high"
          availableLevels={["low", "medium", "high", "xhigh"]}
          onChange={fn()}
        />
        <Story />
      </div>
    ),
  ],
  render: () => <InteractiveToggle initialFastMode />,
};
