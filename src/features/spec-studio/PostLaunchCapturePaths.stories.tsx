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
    canRequestAmendment: true,
    capturePending: false,
    captureOutcomePath: null,
    captureReceipt: null,
    captureFailure: null,
    amendmentPending: false,
    amendmentReceipt: null,
    amendmentEvent: null,
    amendmentFailure: null,
    onCapture: fn(),
    onAmend: fn(),
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

export const DurableAmendmentEvent: Story = {
  args: {
    amendmentReceipt: {
      amended: 1,
      liveRevision: 3,
      policyBasis: "human_operator",
      addedContextIds: [],
      addedTaskIds: ["verify-added-path"],
      addedEdgeIds: [],
      previousWorkingDefinitionHash: "sha256:old",
      workingDefinitionHash: "sha256:new",
    },
    amendmentEvent: {
      type: "graph-workflow-execution-amended",
      projectName: "command-center",
      sessionName: "native-sdd-run",
      executionId: "workflow-execution-1",
      liveRevision: 3,
      reason: "Add live verification.",
      actor: "human",
      policyBasis: "human_operator",
      previousWorkingDefinitionHash: "sha256:old",
      workingDefinitionHash: "sha256:new",
      addedContextIds: [],
      addedTaskIds: ["verify-added-path"],
      addedEdgeIds: [],
    },
  },
};

export const UnlaunchedRedirect: Story = {
  args: {
    executionId: null,
    state: "unlaunched",
    canRequestAmendment: false,
    captureOutcomePath: "discovery",
    captureFailure: {
      message:
        "Delivery plan attempt attempt-3 is approved and has launched no execution.",
      instruction:
        "Nothing was captured. Add the discovered work to the plan itself with `cctl spec plan reopen native-sdd --reason <why>`.",
    },
  },
};

export const NonRunningAmendmentRefusal: Story = {
  args: {
    amendmentFailure: {
      message:
        'Execution "workflow-execution-1" is paused; only a running execution can be amended. Nothing was applied.',
      instruction:
        "Resume the run with `cctl workflow live resume` and re-run the amendment, or plan the work into the next attempt with `cctl spec plan open --seed-from last`.",
    },
  },
};

export const Mobile: Story = {
  parameters: { viewport: { defaultViewport: "mobile1" } },
};
