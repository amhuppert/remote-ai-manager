import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn } from "storybook/test";

import { ExecutionPanel, IntegrityBanner, PolicyDialog } from "./SpecControls";
import { specControlsDetailFixture } from "./SpecControls.fixtures";

const meta = {
  title: "Specs/Studio/PolicyAndExecutionControls",
  component: PolicyDialog,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-bg-void p-xl text-text-primary max-768:p-md">
        <Story />
      </div>
    ),
  ],
  args: {
    currentPolicy: { preset: "contract-bearing" },
    pending: false,
    error: null,
    onChangePolicy: fn(),
  },
} satisfies Meta<typeof PolicyDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Policy: Story = {};

export const ScopeSelection: Story = {
  render: () => (
    <ExecutionPanel
      detail={specControlsDetailFixture()}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
    />
  ),
};

export const DefinitionReview: Story = {
  render: () => (
    <ExecutionPanel
      detail={specControlsDetailFixture("definition_review")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
    />
  ),
};

export const RunningExecution: Story = {
  render: () => (
    <ExecutionPanel
      detail={specControlsDetailFixture("running")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onStart={fn()}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onApproveExecutionStart={fn()}
      onCaptureScopeAmendment={fn()}
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
