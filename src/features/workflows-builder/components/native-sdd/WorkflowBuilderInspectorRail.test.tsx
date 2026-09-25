// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";
import { _useGraphWorkflowBuilderStore } from "@/stores/graph-workflow-builder.store";

import WorkflowBuilderInspectorRail from "./WorkflowBuilderInspectorRail";

const management: NativeSddWorkflowManagementDetail = {
  kind: "native_sdd_delivery",
  specId: "spec-1",
  specSlug: "checkout",
  specName: "Checkout",
  attemptId: "attempt-2",
  pinnedRevisionId: "revision-8",
  pinnedRevisionNumber: 8,
  lifecycle: "draft",
  editable: true,
  isCurrentDefinition: true,
  specHref: "/specs/demo/checkout",
  builderHref: "/projects/demo/workflows?definition=wf-1",
  executionHref: null,
  bindingRevision: 4,
  deltaBasisExecutionId: null,
  binding: {
    dispositions: [
      {
        criterionElementId: "criterion-1",
        disposition: "pending_reaffirmation",
        deliveredByExecutionId: "execution-1",
      },
      {
        criterionElementId: "criterion-2",
        disposition: "in_scope",
        deliveredByExecutionId: null,
      },
    ],
  },
  dispositionCounts: { pending_reaffirmation: 1, in_scope: 1 },
  unresolvedItems: [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      text: "Keeps saved carts",
      disposition: "pending_reaffirmation",
      deliveredByExecutionId: "execution-1",
      contextIds: ["context-plan", "context-implement"],
    },
  ],
  criterionRows: [
    {
      criterionElementId: "criterion-1",
      handle: "R1.1",
      text: "Keeps saved carts",
      disposition: "pending_reaffirmation",
      deliveredByExecutionId: "execution-1",
      contextIds: ["context-plan", "context-implement"],
    },
    {
      criterionElementId: "criterion-2",
      handle: "R1.2",
      text: "Charges once",
      disposition: "in_scope",
      deliveredByExecutionId: null,
      contextIds: ["context-implement"],
    },
  ],
  claims: [
    {
      contextId: "context-plan",
      criterionElementIds: ["criterion-1"],
    },
  ],
  comments: [
    {
      id: "comment-1",
      contextId: "context-plan",
      body: "Keep the migration explicit.",
      author: { kind: "human", id: "alex" },
      createdAt: "2026-08-31T12:00:00.000Z",
      orphaned: false,
    },
  ],
  nextAct: "sign_off",
  currentCandidate: null,
  currentCandidateHash: null,
  currentApproval: null,
  approvedBaseline: {
    snapshotId: "snapshot-1",
    candidateId: "wf-old",
    candidateHash: "sha256:old",
    approvedAt: "2026-08-30T12:00:00.000Z",
    workflowDefinition: {
      id: "wf-old",
      revision: 2,
      definitionHash: "sha256:def",
    },
  },
  changes: {
    workflowSettings: true,
    contexts: true,
    tasks: false,
    edges: true,
    layout: false,
    dispositions: true,
    claims: false,
  },
  capabilities: {
    canSignOff: true,
    canReopen: false,
    canAbandon: true,
    canLaunch: false,
    refusals: {},
  },
};

describe("WorkflowBuilderInspectorRail", () => {
  beforeEach(() => {
    _useGraphWorkflowBuilderStore.setState({ highlightedContextIds: [] });
  });

  it("switches among Config, Scope, and Changes and clears highlights on Config", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowBuilderInspectorRail
        management={management}
        config={<div>Config editor</div>}
      />,
    );

    expect(screen.getByText("Config editor")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Scope" }));
    await user.click(
      screen.getByRole("button", { name: /R1.1 Keeps saved carts/ }),
    );
    expect(
      _useGraphWorkflowBuilderStore.getState().highlightedContextIds,
    ).toEqual(["context-plan", "context-implement"]);

    await user.click(screen.getByRole("tab", { name: "Config" }));
    expect(
      _useGraphWorkflowBuilderStore.getState().highlightedContextIds,
    ).toEqual([]);
  });

  it("batch reaffirms selected pending criteria at the displayed binding revision", async () => {
    const user = userEvent.setup();
    const onReaffirm = vi.fn();
    render(
      <WorkflowBuilderInspectorRail
        management={management}
        config={<div>Config editor</div>}
        onReaffirm={onReaffirm}
      />,
    );

    await user.click(screen.getByRole("tab", { name: "Scope" }));
    await user.click(screen.getByRole("checkbox", { name: /R1.1/ }));
    await user.click(screen.getByRole("button", { name: "Reaffirm selected" }));
    expect(onReaffirm).toHaveBeenCalledWith(["criterion-1"], 4);
    expect(
      screen.getByText("Keep the migration explicit."),
    ).toBeInTheDocument();
  });

  it("clears the batch selection after reaffirmation settles", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <WorkflowBuilderInspectorRail
        management={management}
        config={<div>Config editor</div>}
        onReaffirm={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Scope" }));
    await user.click(screen.getByRole("checkbox", { name: /R1.1/ }));

    rerender(
      <WorkflowBuilderInspectorRail
        management={management}
        config={<div>Config editor</div>}
        onReaffirm={vi.fn()}
        reaffirming
      />,
    );
    rerender(
      <WorkflowBuilderInspectorRail
        management={{ ...management, bindingRevision: 5 }}
        config={<div>Config editor</div>}
        onReaffirm={vi.fn()}
        reaffirming={false}
      />,
    );

    expect(screen.getByRole("checkbox", { name: /R1.1/ })).not.toBeChecked();
  });

  it("shows the approved baseline and grouped changes", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowBuilderInspectorRail
        management={management}
        config={<div>Config editor</div>}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    expect(
      screen.getByText(/Approved baseline wf-old · r2/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Workflow settings Changed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Tasks Unchanged" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Edges / layout Changed" }),
    ).toBeInTheDocument();
  });

  it("names the absence of a baseline on first delivery", async () => {
    const user = userEvent.setup();
    render(
      <WorkflowBuilderInspectorRail
        management={{ ...management, approvedBaseline: null }}
        config={<div>Config editor</div>}
      />,
    );
    await user.click(screen.getByRole("tab", { name: "Changes" }));
    expect(
      screen.getByText("No approved delivery baseline yet."),
    ).toBeInTheDocument();
  });
});
