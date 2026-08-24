// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SpecDetailView } from "@/lib/specs/queries";
import type {
  SpecGatePreset,
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import SpecControlsPanel, {
  ExecutionPanel,
  IntegrityBanner,
  PolicyDialog,
  PolicyAdmissionNotices,
  RenameSpecDialog,
  SpecIntegrityPanel,
} from "./SpecControls";
import {
  denseSpecControlsDetailFixture as denseExecutionFixture,
  draftingSpecControlsDetailFixture as draftingDetailFixture,
  policyAdmissionViewFixture,
  SPEC_CONTROLS_FIXTURE_NOW as NOW,
  specControlsDetailFixture as detailFixture,
} from "./SpecControls.fixtures";

const POLICY_CONFIRMATION_NAME = "Gate policy change — human confirmation";
const POLICY_CONFIRM_BUTTON = "Confirm policy change";
const LOOSENING_WARNING = /at least one gate becomes weaker/i;
const POLICY_IMPACT_NAME = "Impact of this change";
const LIFECYCLE_LIST = "Remaining lifecycle";

function listLabels(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole("listitem")
    .map((item) => item.textContent ?? "");
}

const presetOptionLabels: Record<SpecGatePreset, string> = {
  "contract-bearing": "Contract-bearing",
  exploratory: "Exploratory",
  "fast-path": "Fast path",
};

const presetDirectionMatrix = [
  { from: "contract-bearing", to: "exploratory", loosens: true },
  { from: "exploratory", to: "contract-bearing", loosens: false },
] as const;

describe("PolicyDialog", () => {
  it.each(presetDirectionMatrix)(
    "requires human confirmation for the $from → $to preset switch (loosens: $loosens)",
    async ({ from, to, loosens }) => {
      const onChangePolicy = vi.fn();
      const user = userEvent.setup();
      render(
        <PolicyDialog
          currentPolicy={{ preset: from }}
          pending={false}
          error={null}
          onChangePolicy={onChangePolicy}
        />,
      );

      await user.click(
        screen.getByRole("radio", {
          name: new RegExp(presetOptionLabels[to]),
        }),
      );

      expect(onChangePolicy).not.toHaveBeenCalled();
      const confirmation = screen.getByRole("alertdialog", {
        name: POLICY_CONFIRMATION_NAME,
      });
      expect(
        within(confirmation).getByText(/prospectively only/i),
      ).toBeInTheDocument();
      expect(
        within(confirmation).queryByRole("textbox", {
          name: "Hard confirmation",
        }),
      ).not.toBeInTheDocument();
      if (loosens) {
        expect(
          within(confirmation).getByText(LOOSENING_WARNING),
        ).toBeInTheDocument();
      } else {
        expect(
          within(confirmation).queryByText(LOOSENING_WARNING),
        ).not.toBeInTheDocument();
      }

      await user.click(
        within(confirmation).getByRole("button", {
          name: POLICY_CONFIRM_BUTTON,
        }),
      );

      expect(onChangePolicy).toHaveBeenCalledTimes(1);
      expect(onChangePolicy).toHaveBeenCalledWith({
        proposedPolicy: { preset: to },
        hardConfirmed: true,
      });
    },
  );

  it("cancelling a preset switch submits nothing and restores the current policy", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "exploratory" }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Contract-bearing/ }));
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: POLICY_CONFIRMATION_NAME }),
      ).getByRole("button", { name: "Cancel" }),
    );

    expect(onChangePolicy).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });
    expect(
      within(
        screen.getByRole("radiogroup", { name: "Gate policy preset" }),
      ).getByRole("radio", { name: /Exploratory/ }),
    ).toBeChecked();
  });

  it("opens the human confirmation when an individual gate is loosened", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    const requirementsGate = screen.getByRole("radiogroup", {
      name: "Requirements gate mode",
    });
    await user.click(
      within(requirementsGate).getByRole("radio", { name: "Notify" }),
    );

    const confirmation = screen.getByRole("alertdialog", {
      name: POLICY_CONFIRMATION_NAME,
    });
    expect(
      within(confirmation).getByText(/prospectively only/i),
    ).toBeInTheDocument();
    expect(within(confirmation).getByText(LOOSENING_WARNING)).toBeVisible();
    expect(onChangePolicy).not.toHaveBeenCalled();

    await user.click(
      within(confirmation).getByRole("button", {
        name: POLICY_CONFIRM_BUTTON,
      }),
    );
    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: {
        preset: "contract-bearing",
        overrides: { requirements: "notify" },
      },
      hardConfirmed: true,
    });
  });

  it("submits a same-preset tightening override without any confirmation", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "exploratory" }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    const requirementsGate = screen.getByRole("radiogroup", {
      name: "Requirements gate mode",
    });
    await user.click(
      within(requirementsGate).getByRole("radio", { name: "Gate" }),
    );

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onChangePolicy).toHaveBeenCalledTimes(1);
    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: {
        preset: "exploratory",
        overrides: { requirements: "gate" },
      },
      hardConfirmed: false,
    });
  });

  it("confirms a reset that loosens an override back to the preset default", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{
          preset: "exploratory",
          overrides: { requirements: "gate" },
        }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    await user.click(screen.getByRole("button", { name: "↺ preset" }));

    const confirmation = screen.getByRole("alertdialog", {
      name: POLICY_CONFIRMATION_NAME,
    });
    expect(within(confirmation).getByText(LOOSENING_WARNING)).toBeVisible();
    expect(onChangePolicy).not.toHaveBeenCalled();

    await user.click(
      within(confirmation).getByRole("button", {
        name: POLICY_CONFIRM_BUTTON,
      }),
    );
    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
    });
  });
});

describe("RenameSpecDialog", () => {
  it("refuses an invalid slug locally and carries a changed name", async () => {
    const onRename = vi.fn();
    const user = userEvent.setup();
    render(
      <RenameSpecDialog
        currentSlug="native-sdd"
        currentName="Native SDD"
        pending={false}
        error={null}
        onRename={onRename}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const slugInput = screen.getByRole("textbox", { name: "New slug" });
    await user.clear(slugInput);
    await user.type(slugInput, "Not A Slug!");
    expect(screen.getByRole("button", { name: "Rename spec" })).toBeDisabled();

    await user.clear(slugInput);
    await user.type(slugInput, "native-sdd-v2");
    const nameInput = screen.getByRole("textbox", { name: "Name" });
    await user.clear(nameInput);
    await user.type(nameInput, "Native SDD v2");
    await user.click(screen.getByRole("button", { name: "Rename spec" }));

    expect(onRename).toHaveBeenCalledWith({
      slug: "native-sdd-v2",
      name: "Native SDD v2",
    });
  });
});

describe("ExecutionPanel", () => {
  it("keeps one-off workflow approval on the workflow run", () => {
    const detail = denseExecutionFixture("definition_review");
    detail.spec = { ...detail.spec, slug: "browser-proof-spec" };
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("workflow-review-banner");
    expect(banner).toHaveClass("before:from-amber");
    expect(
      within(banner).getByText("Workflow launch awaiting approval"),
    ).toBeVisible();
    expect(banner).toHaveTextContent(
      "The admitted one-off launch is bound to browser-proof-spec.",
    );
    expect(
      within(banner).getByRole("link", { name: "Request changes" }),
    ).toHaveAttribute("href", "/specs/command-center/browser-proof-spec");

    expect(
      within(banner).queryByRole("button", { name: /approve|start/i }),
    ).toBeNull();
    expect(within(banner).queryByText("Open workflow definition")).toBeNull();
  });

  it("scopes the running merge gate and keeps non-blocking outcomes out of its demand", async () => {
    const detail = denseExecutionFixture("running");
    const onGrantGateApproval = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={onGrantGateApproval}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const mergeGate = screen.getByRole("region", {
      name: "Merge gate for execution-1",
    });
    expect(
      screen.getByText(
        "Contract provenance is locked for this running execution.",
      ),
    ).toHaveClass("text-text-primary");
    expect(
      within(mergeGate).getByText(
        /Scoped only to promised criteria; exclusions remain visible/,
      ),
    ).toHaveClass("text-text-secondary");
    expect(within(mergeGate).getByText("revision 1 pinned")).toHaveClass(
      "text-text-secondary",
    );
    expect(within(mergeGate).getByText("R1.1")).toBeInTheDocument();
    expect(within(mergeGate).getByText("R1.2")).toBeInTheDocument();
    expect(within(mergeGate).getAllByText("Waived").length).toBeGreaterThan(0);
    expect(within(mergeGate).getByText("R1.4")).toBeInTheDocument();
    expect(
      within(mergeGate).getAllByText("Delivered elsewhere").length,
    ).toBeGreaterThan(0);
    expect(within(mergeGate).getByText(/1 deferred criterion/i)).toBeVisible();
    expect(within(mergeGate).getByText(/1 delivered elsewhere/i)).toBeVisible();
    expect(
      within(mergeGate).queryByRole("button", { name: /Merge execution-1/ }),
    ).not.toBeInTheDocument();

    await user.click(
      within(mergeGate).getByRole("button", {
        name: "Approve delivery for merge",
      }),
    );
    expect(onGrantGateApproval).toHaveBeenCalledWith({
      executionId: "execution-1",
      revisionId: "revision-1",
    });
  });

  it("presents a completed workflow as ready for the session delivery merge", () => {
    const detail = denseExecutionFixture("running");
    const execution = detail.executions[0];
    const statusExecution = detail.status.executions[0];
    if (execution === undefined || statusExecution === undefined) {
      throw new Error("Running execution fixture missing");
    }
    execution.workflowExecutionId = "workflow-execution-1";
    detail.status.executions = [
      {
        ...statusExecution,
        workflowExecutionId: "workflow-execution-1",
        workflowStatus: "completed",
      },
    ];

    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByText("Ready to merge")).toBeVisible();
    expect(
      screen.getByText("Workflow complete — ready to merge"),
    ).toBeVisible();
    expect(
      screen.getByText(/Merge session native-sdd-run into its delivery target/),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open session to merge" }),
    ).toHaveAttribute("href", "/projects/command-center/native-sdd-run");
    expect(
      screen.queryByRole("region", { name: "Post-launch capture" }),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Contract provenance is locked for this running execution.",
      ),
    ).toBeNull();
  });

  it("reveals the waiver reason flow only when a scoped criterion is waived", async () => {
    const onGrantWaiver = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={onGrantWaiver}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("textbox", { name: "Waiver reason for R1.1" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Waive R1.1" }));
    await user.type(
      screen.getByRole("textbox", { name: "Waiver reason for R1.1" }),
      "The equivalent trace was reviewed by Alex.",
    );
    await user.click(
      screen.getByRole("button", { name: "Record waiver for R1.1" }),
    );
    expect(onGrantWaiver).toHaveBeenCalledWith({
      criterionElementId: "criterion-1",
      revisionId: "revision-1",
      reason: "The equivalent trace was reviewed by Alex.",
    });
  });

  it("renders controls from an older execution-pinned snapshot", () => {
    const detail = detailFixture("definition_review");
    const pinned = detail.currentRevision;
    if (pinned === null) throw new Error("Pinned fixture missing");
    const approved = snapshotForTest(
      pinned,
      "revision-2",
      2,
      "approved",
      pinned.revision.id,
    );
    const withdrawn = snapshotForTest(
      pinned,
      "revision-3",
      3,
      "withdrawn",
      approved.revision.id,
    );
    const draft = snapshotForTest(
      pinned,
      "revision-4",
      4,
      "draft",
      withdrawn.revision.id,
    );
    const advancedDetail: SpecDetailView = {
      ...detail,
      revisions: [
        pinned.revision,
        approved.revision,
        withdrawn.revision,
        draft.revision,
      ],
      baseRevision: withdrawn,
      currentRevision: draft,
      currentApprovedRevision: approved,
      executionRevisionSnapshots: [pinned],
    };

    render(
      <ExecutionPanel
        detail={advancedDetail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByText("R1.1")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Disposition for R1.1" }),
    ).toBeInTheDocument();
  });

  it("does not expose terminal disposition controls for a criterion excluded at start", () => {
    const detail = detailFixture("definition_review");
    const pinned = detail.executionRevisionSnapshots[0];
    const execution = detail.executions[0];
    if (pinned === undefined || execution === undefined) {
      throw new Error("Execution fixture missing");
    }
    const sourceCriterion = pinned.elements.find(
      (entry) => entry.element.id === "criterion-1",
    );
    if (
      sourceCriterion === undefined ||
      sourceCriterion.version.payload.kind !== "criterion"
    ) {
      throw new Error("Criterion fixture missing");
    }
    pinned.elements.push({
      element: {
        ...sourceCriterion.element,
        id: "criterion-2",
        number: 2,
      },
      version: {
        ...sourceCriterion.version,
        elementId: "criterion-2",
        position: 2,
        payload: {
          ...sourceCriterion.version.payload,
          text: "Excluded work remains outside this delivery.",
        },
        payloadHash: "criterion-2-hash",
      },
    });
    execution.scope = {
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [
        { criterionId: "criterion-2", disposition: "deferred" },
      ],
    };
    detail.criterionDispositions.push({
      execution_id: execution.id,
      criterion_element_id: "criterion-2",
      disposition: "deferred",
      waiver_id: null,
      delivered_by_execution_id: null,
      created_at: NOW,
      updated_at: NOW,
    });

    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByText("R1.2")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Disposition for R1.2" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Waive R1.2" })).toBeNull();
  });

  it("renders the admitted state instead of the blocking prompt once delivery approval is granted", () => {
    const detail = detailFixture("definition_review");
    detail.gateAdmissions = [
      policyAdmissionViewFixture({
        id: "admission-1",
        gate: "delivery",
        basis: "human_approval",
        approvalId: "approval-1",
        executionId: "execution-1",
        actor: { kind: "human" },
        createdAt: NOW,
      }),
    ];
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve delivery for merge" }),
    ).toBeNull();
    expect(screen.queryByText(/refuses this run's merge/)).toBeNull();
    expect(screen.getByText("Delivery approved")).toBeInTheDocument();
    // Honest representation: approval satisfies one gate condition — the
    // merge can still be refused for missing or stale criterion proof.
    expect(screen.queryByText(/will admit its merge/)).toBeNull();
    expect(
      screen.getByText(/still needs valid proof or a waiver/),
    ).toBeInTheDocument();
  });

  it("offers abandonment once the workflow completed, the one running state blocking replan cannot reach", async () => {
    const detail = detailFixture("running");
    const execution = detail.executions[0];
    const statusExecution = detail.status.executions[0];
    if (execution === undefined || statusExecution === undefined) {
      throw new Error("Running execution fixture missing");
    }
    execution.workflowExecutionId = "workflow-execution-1";
    detail.status.executions = [
      {
        ...statusExecution,
        workflowExecutionId: "workflow-execution-1",
        workflowStatus: "completed",
      },
    ];
    const onAbandonExecution = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={onAbandonExecution}
      />,
    );

    // Blocking replan is gone once the workflow finished, so without this form
    // a run whose work landed outside its lane has no way to leave `running`.
    expect(
      screen.queryByRole("region", { name: "Blocking replan" }),
    ).toBeNull();

    await user.type(
      screen.getByRole("textbox", { name: "Abandonment reason" }),
      "The work landed on main outside this lane.",
    );
    await user.click(screen.getByRole("button", { name: "Abandon execution" }));

    expect(onAbandonExecution).toHaveBeenCalledWith({
      executionId: "execution-1",
      reason: "The work landed on main outside this lane.",
    });
  });

  it("offers abandonment during definition review so a stuck run can always be stopped", async () => {
    const onAbandonExecution = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={onAbandonExecution}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Abandonment reason" }),
      "Compiled from a superseded revision.",
    );
    await user.click(screen.getByRole("button", { name: "Abandon execution" }));

    expect(onAbandonExecution).toHaveBeenCalledWith({
      executionId: "execution-1",
      reason: "Compiled from a superseded revision.",
    });
  });

  it("records a criterion disposition against the active execution", async () => {
    const detail = detailFixture("definition_review");
    detail.waivers = [
      {
        id: "waiver-1",
        spec_id: "spec-1",
        criterion_element_id: "criterion-1",
        revision_id: "revision-1",
        reason: "Alex accepted the bounded risk.",
        waived_at: NOW,
        stale: 0,
      },
    ];
    const onSetDisposition = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={onSetDisposition}
        onGrantGateApproval={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("combobox", { name: "Disposition for R1.1" }),
    );
    expect(screen.queryByRole("option", { name: "In scope" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Deferred" })).toBeNull();
    await user.click(screen.getByRole("option", { name: "Waived" }));
    await user.click(
      screen.getByRole("button", { name: "Save disposition for R1.1" }),
    );

    expect(onSetDisposition).toHaveBeenCalledWith({
      executionId: "execution-1",
      criterionElementId: "criterion-1",
      disposition: "waived",
      waiverId: "waiver-1",
    });
  });
});

function snapshotForTest(
  source: SpecRevisionSnapshot,
  id: string,
  number: number,
  state: SpecRevisionState,
  basedOnRevisionId: string | null,
): SpecRevisionSnapshot {
  const revision = {
    ...source.revision,
    id,
    number,
    state,
    basedOnRevisionId,
    contentHash: state === "draft" ? null : `${id}-hash`,
    proposedAt: state === "draft" ? null : NOW,
    approvedAt: state === "approved" ? NOW : null,
  };
  return {
    revision,
    elements: source.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: id },
    })),
    assumptionCitations: source.assumptionCitations.map((citation) => ({
      ...citation,
      revisionId: id,
    })),
  };
}

describe("PolicyAdmissionNotices", () => {
  it("11.2 surfaces Notify-basis admissions for post-hoc review, pointing at the correction operations", () => {
    render(
      <PolicyAdmissionNotices
        admissions={[
          policyAdmissionViewFixture({
            id: "admission-1",
            gate: "requirements",
          }),
          policyAdmissionViewFixture({
            id: "admission-2",
            gate: "plan",
            revisionId: null,
            revisionNumber: null,
          }),
          policyAdmissionViewFixture({
            id: "admission-3",
            gate: "design",
            basis: "off_policy",
          }),
          policyAdmissionViewFixture({
            id: "admission-4",
            gate: "delivery",
            basis: "human_approval",
            approvalId: "approval-1",
          }),
        ]}
      />,
    );

    const notices = screen.getAllByText("Proceeded under Notify");
    expect(notices).toHaveLength(2);
    expect(screen.getByText(/Requirements/)).toBeInTheDocument();
    expect(screen.getByText(/Plan/)).toBeInTheDocument();
    expect(screen.getByText("Proceeded with gate off")).toBeInTheDocument();
    expect(
      screen.getByText(/request changes, an amendment, or abandoning/i),
    ).toBeInTheDocument();
    // Human approvals are the normal path — never listed for post-hoc review.
    expect(screen.queryByText(/Delivery/)).toBeNull();
  });
});

describe("IntegrityBanner", () => {
  it("surfaces every verify mismatch as a blocking integrity banner", () => {
    render(
      <IntegrityBanner
        report={{
          ok: false,
          checkedRevisionIds: ["revision-1"],
          mismatches: [
            {
              revisionId: "revision-1",
              expectedContentHash: "expected-hash",
              actualContentHash: "actual-hash",
              expectedCitationHash: "1".repeat(64),
              actualCitationHash: "2".repeat(64),
              mismatchedElementIds: ["requirement-1"],
            },
          ],
          consistencyFindings: [],
        }}
        isPending={false}
        error={null}
      />,
    );

    const banner = screen.getByRole("alert");
    expect(banner).toHaveTextContent("Integrity mismatch");
    expect(banner).toHaveTextContent("revision-1");
    expect(banner).toHaveTextContent("requirement-1");
  });
});

describe("SpecIntegrityPanel", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  // React remounts every effect once under StrictMode, so a verification whose
  // result lands after that remount — the normal case over a real network — is
  // dropped unless the report survives independently of the requesting mount.
  it("reports a verification that resolves after React's double mount", async () => {
    const detail = detailFixture();
    let release = (): void => {};
    const inFlight = new Promise<void>((resolve) => {
      release = () => {
        resolve();
      };
    });
    api.reply(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
      async () => {
        await inFlight;
        return {
          json: {
            ok: true,
            checkedRevisionIds: ["revision-1"],
            mismatches: [],
            consistencyFindings: [],
          },
        };
      },
    );

    renderWithQuery(
      <StrictMode>
        <SpecIntegrityPanel detail={detail} projectName="command-center" />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(
        api.requestsTo(
          "POST",
          `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
        ).length,
      ).toBeGreaterThan(0);
    });
    release();

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Integrity intact",
    );
  });
});

describe("SpecControlsPanel policy impact", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  // The panel is where the open draft is read from, and the preview must
  // resolve the *proposed* dials: the stored sequence for this contract-bearing
  // spec says the design stage is concluded by a human propose, while the
  // exploratory posture being confirmed turns it into an agent proposal.
  it("previews the confirmed policy against the spec's open draft, not the stored sequence", async () => {
    const detail = draftingDetailFixture("design");
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="gate"
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Exploratory/ }));

    const impact = within(
      screen.getByRole("alertdialog", { name: POLICY_CONFIRMATION_NAME }),
    ).getByRole("region", { name: POLICY_IMPACT_NAME });

    expect(within(impact).getByText("Design → Design")).toBeVisible();
    expect(
      within(impact).getByText(/rev 2 keeps its Design stage/i),
    ).toBeVisible();
    expect(
      within(impact).getByText(/Propose the Design stage/i),
    ).toHaveTextContent("the agent may proceed");
    expect(
      listLabels(within(impact).getByRole("list", { name: LIFECYCLE_LIST })),
    ).toEqual([
      "Design · Notify",
      "Execution start · Notify",
      "Delivery · Gate",
    ]);
  });
});

describe("SpecControlsPanel gate policy change", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  // change-policy resolves to the spec *and* what the open draft still owes
  // under the confirmed dials. A response schema narrower than the action's
  // real return turns every accepted change into a visible failure, because
  // the parse — not the server — is what rejects it.
  it("reports an accepted policy change as success rather than an error", async () => {
    const detail = draftingDetailFixture("design");
    const changePolicyPath = `/api/specs/command-center/${detail.spec.slug}/actions/change-policy`;
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    let releaseResponse = (): void => {};
    const responseReleased = new Promise<void>((resolve) => {
      releaseResponse = () => resolve();
    });
    api.reply("POST", changePolicyPath, async () => {
      await responseReleased;
      return {
        json: {
          spec: { ...detail.spec, gatePolicy: { preset: "exploratory" } },
          authoringSequence: detail.status.authoringSequence,
        },
      };
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="gate"
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Exploratory/ }));
    await user.click(
      within(
        screen.getByRole("alertdialog", { name: POLICY_CONFIRMATION_NAME }),
      ).getByRole("button", { name: POLICY_CONFIRM_BUTTON }),
    );

    const policyRegion = await screen.findByRole("region", {
      name: "Gate policy",
    });
    await waitFor(() => {
      expect(policyRegion).toHaveAttribute("aria-busy", "true");
    });
    expect(api.requestsTo("POST", changePolicyPath)[0]?.jsonBody).toEqual({
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
    });

    releaseResponse();

    await waitFor(() => {
      expect(policyRegion).toHaveAttribute("aria-busy", "false");
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("SpecControlsPanel post-launch capture routes", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  function runningDpaDetail(): SpecDetailView {
    const detail = detailFixture("running");
    const execution = detail.executions[0];
    const statusExecution = detail.status.executions[0];
    if (execution === undefined || statusExecution === undefined) {
      throw new Error("Running execution fixture missing");
    }
    execution.workflowExecutionId = "workflow-execution-1";
    detail.status.executions = [
      {
        ...statusExecution,
        workflowExecutionId: "workflow-execution-1",
        workflowStatus: "running",
      },
    ];
    return detail;
  }

  it("posts a blocking discovery through the coordinator route and shows its durable replacement receipt", async () => {
    const detail = runningDpaDetail();
    const capturePath = `/api/specs/command-center/${detail.spec.slug}/actions/capture-scope-amendment`;
    api.json(
      "GET",
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow/events",
      { events: [] },
    );
    api.json("POST", capturePath, {
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
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="execution"
      />,
    );

    const replan = screen.getByRole("region", { name: "Blocking replan" });
    await user.type(
      within(replan).getByRole("textbox", { name: "Replan task title" }),
      "Replace the migration order",
    );
    await user.type(
      within(replan).getByRole("textbox", {
        name: "Replan task instructions",
      }),
      "Seed the corrected order.",
    );
    await user.type(
      within(replan).getByRole("textbox", { name: "Blocking reason" }),
      "The current dependency order cannot complete.",
    );
    await user.click(
      within(replan).getByRole("button", { name: "Replan execution" }),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Abandon execution-1 and open seeded plan",
      }),
    );

    await waitFor(() => {
      expect(api.requestsTo("POST", capturePath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", capturePath)[0]?.jsonBody).toEqual({
      executionId: "execution-1",
      discoveredTask: {
        title: "Replace the migration order",
        instructions: "Seed the corrected order.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      blockingReason: "The current dependency order cannot complete.",
    });
    expect(
      await within(replan).findByText("Seeded replacement opened"),
    ).toBeVisible();
    expect(within(replan).getByText(/abandoned execution-1/)).toBeVisible();
    expect(within(replan).getByText(/new attempt-4/)).toBeVisible();
  });
});

describe("SpecControlsPanel whole-spec abandonment", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  it.each(["execution", "gate"] as const)(
    "makes the %s surface terminal once the spec is abandoned",
    (surface) => {
      const detail = detailFixture();
      detail.spec = {
        ...detail.spec,
        abandonedAt: NOW,
        abandonedReason: "Superseded by the ticket-native rewrite.",
      };
      detail.status.phase = {
        primary: "abandoned",
        authoringStage: "plan",
      };

      renderWithQuery(
        <SpecControlsPanel
          detail={detail}
          projectName="command-center"
          surface={surface}
        />,
      );

      expect(
        screen.getByRole("heading", { name: "Abandoned spec — read-only" }),
      ).toBeVisible();
      expect(screen.getByText(/ticket-native rewrite/)).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Start execution" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("radiogroup", { name: "Gate policy preset" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Rename spec" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Abandon whole spec" }),
      ).not.toBeInTheDocument();
    },
  );

  // The CLI path is refused as human-only, so this surface is the only place
  // the whole-spec action can be reached: the control must be wired into the
  // composed panel, not merely exported.
  it("posts the confirmed abandonment through the spec action path", async () => {
    const detail = detailFixture();
    const abandonPath = `/api/specs/command-center/${detail.spec.slug}/actions/abandon-spec`;
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    api.json("POST", abandonPath, {
      ...detail.spec,
      abandonedAt: NOW,
      abandonedReason: "Superseded by the ticket-native rewrite.",
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="execution"
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Abandon whole spec" }),
    );
    await user.type(
      screen.getByRole("textbox", { name: "Spec abandonment reason" }),
      "Superseded by the ticket-native rewrite.",
    );
    await user.click(
      screen.getByRole("button", { name: "Abandon spec permanently" }),
    );

    await waitFor(() => {
      expect(api.requestsTo("POST", abandonPath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", abandonPath)[0]?.jsonBody).toEqual({
      reason: "Superseded by the ticket-native rewrite.",
    });
  });

  // Rename is human-only for the same reason abandon is, so the refusal sends
  // agents here; the dialog existed but no surface rendered it, leaving the
  // capability unreachable from the session the refusal names.
  it("posts the confirmed rename through the spec action path", async () => {
    const detail = detailFixture();
    const renamePath = `/api/specs/command-center/${detail.spec.slug}/actions/rename`;
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    api.json("POST", renamePath, {
      spec: { ...detail.spec, slug: "renamed-spec" },
      alias: {
        specId: detail.spec.id,
        slug: detail.spec.slug,
        createdAt: NOW,
      },
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="gate"
      />,
    );

    await user.click(screen.getByRole("button", { name: "Rename" }));
    const slugField = screen.getByRole("textbox", { name: "New slug" });
    await user.clear(slugField);
    await user.type(slugField, "renamed-spec");
    await user.click(screen.getByRole("button", { name: "Rename spec" }));

    await waitFor(() => {
      expect(api.requestsTo("POST", renamePath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", renamePath)[0]?.jsonBody).toEqual({
      slug: "renamed-spec",
    });
  });
});
