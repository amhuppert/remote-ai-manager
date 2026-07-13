"use client";

import { useEffect, useRef, useState } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";
import { RichPromptInput } from "./RichPromptInput";

function WithVoiceHealthMock({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  const originalFetchRef = useRef<typeof window.fetch | null>(null);
  useEffect(() => {
    originalFetchRef.current = window.fetch.bind(window);
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/api/voice/health")) {
        return Promise.resolve(Response.json({ available: false }));
      }
      return originalFetchRef.current!(input, init);
    }) as typeof window.fetch;
    return () => {
      if (originalFetchRef.current) window.fetch = originalFetchRef.current;
    };
  }, []);
  return <>{children}</>;
}

function RichPromptInputDemo({
  disabled = false,
  readOnly = false,
}: {
  disabled?: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const [value, setValue] = useState("");

  return (
    <div className="w-[560px] max-w-full rounded-[var(--radius-md)] border border-[var(--border-subtle)] bg-[var(--bg-base)] p-[var(--space-md)]">
      <RichPromptInput
        capabilityContext={{ projectName: "command-center" }}
        value={value}
        onValueChange={setValue}
        onSubmit={fn()}
        ariaLabel="Prompt"
        placeholder="Describe the agent task"
        submitLabel="Create session"
        disabled={disabled}
        readOnly={readOnly}
      />
    </div>
  );
}

const meta = {
  title: "Shared/RichPromptInput",
  component: RichPromptInputDemo,
  parameters: {
    a11y: { test: "error" },
    layout: "centered",
  },
  decorators: [
    (Story) => (
      <WithVoiceHealthMock>
        <Story />
      </WithVoiceHealthMock>
    ),
  ],
} satisfies Meta<typeof RichPromptInputDemo>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Disabled: Story = {
  args: { disabled: true },
};

export const ReadOnly: Story = {
  args: { readOnly: true },
};
