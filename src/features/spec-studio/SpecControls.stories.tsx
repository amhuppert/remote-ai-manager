import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";

import { ExecutionPanel, IntegrityBanner, PolicyDialog } from "./SpecControls";
import { denseSpecControlsDetailFixture } from "./SpecControls.fixtures";

const meta = {
  title: "Specs/Studio/PolicyAndExecutionControls",
  component: PolicyDialog,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <main className="h-screen overflow-y-auto bg-bg-void p-xl text-text-primary max-768:p-md">
        <h1 className="sr-only">Spec policy and execution controls</h1>
        <Story />
      </main>
    ),
  ],
  args: {
    currentPolicy: { preset: "contract-bearing" },
    pending: false,
    error: null,
    onChangePolicy: fn(),
    specSlug: "native-sdd",
    backHref: "/specs/command-center/native-sdd",
  },
} satisfies Meta<typeof PolicyDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Policy: Story = {};

export const ExploratoryPolicy: Story = {
  args: { currentPolicy: { preset: "exploratory" } },
};

export const FastPathPolicy: Story = {
  args: { currentPolicy: { preset: "fast-path" } },
};

export const LooseningConfirmation: Story = {
  play: async () => {
    await userEvent.click(
      within(document.body).getByRole("radio", { name: /Exploratory/ }),
    );
  },
};

export const ScopeSelection: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("none")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

export const DefinitionReview: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("definition_review")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

export const RunningExecution: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("running")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

export const IntegrityMismatch: Story = {
  render: () => (
    <IntegrityBanner
      report={{
        ok: false,
        checkedRevisionIds: ["revision-1"],
        mismatches: [
          {
            revisionId: "revision-1",
            expectedContentHash: "expected-hash",
            actualContentHash: "actual-hash",
            mismatchedElementIds: ["requirement-1"],
          },
        ],
      }}
      isPending={false}
      error={null}
    />
  ),
};
