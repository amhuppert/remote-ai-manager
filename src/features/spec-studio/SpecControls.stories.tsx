import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { fn, userEvent, within } from "storybook/test";

import {
  AbandonSpecPanel,
  ExecutionPanel,
  IntegrityBanner,
  PolicyDialog,
} from "./SpecControls";
import {
  approvedAwaitingProofSpecControlsDetailFixture,
  denseSpecControlsDetailFixture,
  policyImpactDraftFixture,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";

function completedWorkflowDetail() {
  const detail = denseSpecControlsDetailFixture("running");
  const execution = detail.executions[0];
  const statusExecution = detail.status.executions[0];
  if (execution === undefined || statusExecution === undefined) {
    throw new Error(
      "Completed workflow story fixture is missing its execution",
    );
  }
  execution.workflowExecutionId = "workflow-execution-1";
  detail.status.executions = [
    {
      ...statusExecution,
      workflowExecutionId: "workflow-execution-1",
      workflowStatus: "completed",
    },
  ];
  return detail;
}

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

export const TighteningConfirmation: Story = {
  args: { currentPolicy: { preset: "exploratory" } },
  play: async () => {
    await userEvent.click(
      within(document.body).getByRole("radio", { name: /Contract-bearing/ }),
    );
  },
};

export const PolicyImpactOnOpenDraft: Story = {
  args: { openDraft: policyImpactDraftFixture("design") },
  play: async () => {
    await userEvent.click(
      within(document.body).getByRole("radio", { name: /Exploratory/ }),
    );
  },
};

export const DeliveryPlanLaunchHandoff: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("none")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

export const WorkflowReview: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("definition_review")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

/** Waived + delivered-elsewhere mix on the merge gate, with the per-row proof
 *  chips and the split proof-recorded/merged-proof counter. */
export const RunningExecution: Story = {
  render: () => (
    <ExecutionPanel
      detail={denseSpecControlsDetailFixture("running")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

/** The graph workflow has published into its session, so delivery now moves
 *  through the separate session-to-target merge — and, when that merge happens
 *  elsewhere or never, through the abandon form that is this run's only exit. */
export const ReadyToMerge: Story = {
  render: () => (
    <ExecutionPanel
      detail={completedWorkflowDetail()}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

/** The delivery approval is still pending, so the merge gate shows the
 *  human Approve button beside the awaiting-proof criterion row. */
export const MergeGateApprovalPending: Story = {
  render: () => (
    <ExecutionPanel
      detail={specControlsDetailFixture("running")}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

/** Delivery already approved by a human: proof chips carry the remaining
 *  demand and the counter separates recorded proof from merged proof. */
export const MergeGateApprovedAwaitingProof: Story = {
  render: () => (
    <ExecutionPanel
      detail={approvedAwaitingProofSpecControlsDetailFixture()}
      projectName="command-center"
      pendingAction={null}
      error={null}
      onGrantWaiver={fn()}
      onSetDisposition={fn()}
      onGrantGateApproval={fn()}
      onCaptureScopeAmendment={fn()}
      onAbandonExecution={fn()}
    />
  ),
};

export const AbandonSpec: Story = {
  render: () => (
    <AbandonSpecPanel
      slug="native-sdd"
      abandonedAt={null}
      abandonedReason={null}
      pending={false}
      error={null}
      onAbandonSpec={fn()}
    />
  ),
};

export const AbandonSpecConfirmation: Story = {
  ...AbandonSpec,
  play: async () => {
    const body = within(document.body);
    await userEvent.click(
      body.getByRole("button", { name: "Abandon whole spec" }),
    );
    await userEvent.type(
      body.getByRole("textbox", { name: "Spec abandonment reason" }),
      "Superseded by the ticket-native rewrite.",
    );
  },
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
        consistencyFindings: [],
      }}
      isPending={false}
      error={null}
    />
  ),
};
