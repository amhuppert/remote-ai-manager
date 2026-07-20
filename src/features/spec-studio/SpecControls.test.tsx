// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type {
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import {
  ExecutionPanel,
  IntegrityBanner,
  PolicyAdmissionNotices,
  PolicyDialog,
  RenameSpecDialog,
} from "./SpecControls";
import {
  policyAdmissionRowFixture,
  SPEC_CONTROLS_FIXTURE_NOW as NOW,
  specControlsDetailFixture as detailFixture,
} from "./SpecControls.fixtures";

describe("PolicyDialog", () => {
  it("requires the exact hard confirmation before a preset switch", async () => {
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

    await user.click(screen.getByRole("button", { name: "Change policy" }));
    await user.click(screen.getByRole("combobox", { name: "Preset" }));
    await user.click(screen.getByRole("option", { name: /Exploratory/ }));

    const apply = screen.getByRole("button", { name: "Apply policy" });
    expect(apply).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Hard confirmation" }),
      "APPLY PROSPECTIVELY",
    );
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: { preset: "exploratory" },
      hardConfirmed: true,
    });
  });

  it("requires hard confirmation when an individual gate is loosened", async () => {
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

    await user.click(screen.getByRole("button", { name: "Change policy" }));
    await user.click(
      screen.getByRole("combobox", { name: "Requirements gate" }),
    );
    await user.click(screen.getByRole("option", { name: "Notify" }));

    const apply = screen.getByRole("button", { name: "Apply policy" });
    expect(apply).toBeDisabled();
    expect(screen.getByText(/prospective executions/i)).toBeInTheDocument();
  });
});

describe("RenameSpecDialog", () => {
  it("submits a valid new slug and keeps the unchanged name out of the request", async () => {
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
    const apply = screen.getByRole("button", { name: "Rename spec" });
    // The prefilled slug equals the current one, so there is nothing to do.
    expect(apply).toBeDisabled();

    const slugInput = screen.getByRole("textbox", { name: "New slug" });
    await user.clear(slugInput);
    await user.type(slugInput, "native-sdd-v2");
    expect(apply).toBeEnabled();
    await user.click(apply);

    expect(onRename).toHaveBeenCalledWith({ slug: "native-sdd-v2" });
  });

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
  it("starts an approved revision with the selected task and criterion scope", async () => {
    const onStart = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture()}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={onStart}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Session name" }),
      "native-sdd-run",
    );
    await user.click(screen.getByRole("button", { name: "Start execution" }));

    expect(onStart).toHaveBeenCalledWith({
      revisionId: "revision-1",
      sessionName: "native-sdd-run",
      scope: {
        selectedTaskIds: ["task-1"],
        selectedCriterionIds: ["criterion-1"],
        exclusionDispositions: [],
      },
    });
  });

  it("starts the retained approved revision after newer review history advances", async () => {
    const detail = detailFixture();
    const approved = detail.currentApprovedRevision;
    if (approved === null) throw new Error("Approved fixture missing");
    const withdrawn = snapshotForTest(
      approved,
      "revision-2",
      2,
      "withdrawn",
      approved.revision.id,
    );
    const draft = snapshotForTest(
      approved,
      "revision-3",
      3,
      "draft",
      withdrawn.revision.id,
    );
    const advancedDetail: SpecDetailView = {
      ...detail,
      revisions: [approved.revision, withdrawn.revision, draft.revision],
      baseRevision: withdrawn,
      currentRevision: draft,
      currentApprovedRevision: approved,
    };
    const onStart = vi.fn();
    const user = userEvent.setup();

    render(
      <ExecutionPanel
        detail={advancedDetail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={onStart}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Start execution" }));

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ revisionId: approved.revision.id }),
    );
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
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(screen.getByText("R1.1")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Disposition for R1.1" }),
    ).toBeInTheDocument();
  });

  it("records a reason when the human grants a criterion waiver", async () => {
    const onGrantWaiver = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={onGrantWaiver}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(screen.getByText("Definition review")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open workflow definition" }),
    ).toHaveAttribute(
      "href",
      "/projects/command-center/workflows?definition=workflow-definition-1",
    );
    const grant = screen.getByRole("button", { name: "Grant waiver for R1.1" });
    expect(grant).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Waiver reason for R1.1" }),
      "Hardware capture is unavailable; Alex reviewed the equivalent trace.",
    );
    await user.click(grant);

    expect(onGrantWaiver).toHaveBeenCalledWith({
      criterionElementId: "criterion-1",
      revisionId: "revision-1",
      reason:
        "Hardware capture is unavailable; Alex reviewed the equivalent trace.",
    });
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
    execution.scope_json = JSON.stringify({
      selectedTaskIds: ["task-1"],
      selectedCriterionIds: ["criterion-1"],
      exclusionDispositions: [
        { criterionId: "criterion-2", disposition: "deferred" },
      ],
    });
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
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(screen.getByText("R1.2")).toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Disposition for R1.2" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Grant waiver for R1.2" }),
    ).toBeNull();
  });

  it("approves execution start for a definition-review run when the execution-start dial is a gate", async () => {
    const onApproveExecutionStart = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={onApproveExecutionStart}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/won't run until a human approves/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve & start" }));

    expect(onApproveExecutionStart).toHaveBeenCalledWith({
      executionId: "execution-1",
    });
  });

  it("renders the recorded execution-start approval without claiming the run started", () => {
    const detail = detailFixture("definition_review");
    detail.gateAdmissions = [
      {
        id: "admission-start-1",
        spec_id: "spec-1",
        gate: "execution_start",
        basis: "human_approval",
        approval_id: "approval-start-1",
        revision_id: "revision-1",
        execution_id: "execution-1",
        actor_json: '{"kind":"human"}',
        created_at: NOW,
      },
    ];
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve & start" }),
    ).toBeNull();
    expect(screen.getByText("Execution start approved")).toBeInTheDocument();
    expect(screen.getByText(/approval stays recorded/)).toBeInTheDocument();
  });

  it("links the workflow run to the pinned session's workflow page once it exists", () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    execution.state = "running";
    execution.workflow_execution_id = "workflow-execution-9";
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Open workflow run" }),
    ).toHaveAttribute(
      "href",
      "/projects/command-center/native-sdd-run/workflow",
    );
  });

  it("grants the delivery approval for the active execution when the delivery dial is a gate", async () => {
    const onGrantGateApproval = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={onGrantGateApproval}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve delivery" }));

    expect(onGrantGateApproval).toHaveBeenCalledWith({
      executionId: "execution-1",
      revisionId: "revision-1",
    });
  });

  it("renders the admitted state instead of the blocking prompt once delivery approval is granted", () => {
    const detail = detailFixture("definition_review");
    detail.gateAdmissions = [
      {
        id: "admission-1",
        spec_id: "spec-1",
        gate: "delivery",
        basis: "human_approval",
        approval_id: "approval-1",
        revision_id: "revision-1",
        execution_id: "execution-1",
        actor_json: '{"kind":"human"}',
        created_at: NOW,
      },
    ];
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve delivery" }),
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

  it("hides the delivery approval control when the delivery dial resolves to notify", () => {
    const detail = detailFixture("definition_review");
    detail.spec.gatePolicy = {
      preset: "contract-bearing",
      overrides: { delivery: "notify" },
    };
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve delivery" }),
    ).toBeNull();
  });

  it("16.9 captures discovered work against the running execution without a blocking reason", async () => {
    const onCaptureScopeAmendment = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={onCaptureScopeAmendment}
      />,
    );

    const capture = screen.getByRole("button", {
      name: "Capture discovered work",
    });
    expect(capture).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Discovered task title" }),
      "Handle the discovered migration",
    );
    expect(capture).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Discovered task instructions" }),
      "Write the follow-up migration.",
    );
    // The pinned scope stays untouched — the copy must say so.
    expect(screen.getByText(/pinned scope never changes/)).toBeInTheDocument();
    await user.click(capture);

    expect(onCaptureScopeAmendment).toHaveBeenCalledWith({
      executionId: "execution-1",
      discoveredTask: {
        title: "Handle the discovered migration",
        instructions: "Write the follow-up migration.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
    });
  });

  it("16.9 requires a reason before capturing blocking work and passes it through", async () => {
    const onCaptureScopeAmendment = vi.fn();
    const user = userEvent.setup();
    render(
      <ExecutionPanel
        detail={detailFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={onCaptureScopeAmendment}
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Discovered task title" }),
      "Handle the discovered migration",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Discovered task instructions" }),
      "Write the follow-up migration.",
    );
    await user.click(screen.getByRole("checkbox", { name: /Blocks this run/ }));

    const capture = screen.getByRole("button", {
      name: "Capture discovered work",
    });
    expect(capture).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Blocking reason" }),
      "The migration must land before this run can proceed.",
    );
    await user.click(capture);

    expect(onCaptureScopeAmendment).toHaveBeenCalledWith({
      executionId: "execution-1",
      discoveredTask: {
        title: "Handle the discovered migration",
        instructions: "Write the follow-up migration.",
        tracedRequirementElementIds: [],
        tracedDecisionElementIds: [],
        coveredCriterionElementIds: [],
        dependsOnTaskElementIds: [],
      },
      blockingReason: "The migration must land before this run can proceed.",
    });
  });

  it("does not offer capture during definition review, mirroring the server's running-only refusal", () => {
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Capture discovered work" }),
    ).toBeNull();
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
        onStart={vi.fn()}
        onGrantWaiver={vi.fn()}
        onSetDisposition={onSetDisposition}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
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
  };
}

describe("PolicyAdmissionNotices", () => {
  it("11.2 surfaces Notify-basis admissions for post-hoc review, pointing at the correction operations", () => {
    render(
      <PolicyAdmissionNotices
        admissions={[
          policyAdmissionRowFixture({
            id: "admission-1",
            gate: "requirements",
          }),
          policyAdmissionRowFixture({
            id: "admission-2",
            gate: "plan",
            revision_id: null,
          }),
          policyAdmissionRowFixture({
            id: "admission-3",
            gate: "design",
            basis: "off_policy",
          }),
          policyAdmissionRowFixture({
            id: "admission-4",
            gate: "delivery",
            basis: "human_approval",
            approval_id: "approval-1",
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

  it("renders nothing when every admission has a human approval basis", () => {
    const { container } = render(
      <PolicyAdmissionNotices
        admissions={[
          policyAdmissionRowFixture({
            basis: "human_approval",
            approval_id: "approval-1",
          }),
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
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
              mismatchedElementIds: ["requirement-1"],
            },
          ],
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
