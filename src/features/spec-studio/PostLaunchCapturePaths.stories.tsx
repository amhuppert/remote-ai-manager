import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import PostLaunchCapturePaths from "./PostLaunchCapturePaths";

const meta = {
  title: "Specs/Studio/PostLaunchCapturePaths",
  component: PostLaunchCapturePaths,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="min-h-screen bg-bg-void p-xl text-text-primary max-768:p-md">
        <Story />
      </main>
    ),
  ],
  args: {
    projectName: "command-center",
    slug: "native-sdd",
    executionId: "execution-1",
    state: "running",
    capturePending: false,
    captureOutcomePath: null,
    captureReceipt: null,
    captureFailure: null,
    onCapture: fn(),
  },
} satisfies Meta<typeof PostLaunchCapturePaths>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = {};

export const SeededReplacementReceipt: Story = {
  args: {
    captureOutcomePath: "replan",
    captureReceipt: {
      discovery: {
        id: "discovery-8",
        executionId: "execution-1",
        attemptId: "attempt-3",
        title: "Replace the migration order",
      },
      restartRequired: true,
      replacement: {
        abandonedExecutionId: "execution-1",
        replacementAttemptId: "attempt-4",
      },
    },
  },
};

export const UnlaunchedRedirect: Story = {
  args: {
    executionId: null,
    state: "unlaunched",
    captureOutcomePath: "discovery",
    captureFailure: {
      message:
        "Delivery plan attempt attempt-3 is approved and has launched no execution.",
      instruction:
        "Nothing was captured. Add the discovered work to the plan itself with `cctl spec plan reopen native-sdd --reason <why>`.",
    },
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
