// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { NativeSddWorkflowManagementDetail } from "@/lib/workflow-graph/managed-definition";

import ManagedDeliveryWorkflowHeader from "./ManagedDeliveryWorkflowHeader";

function management(
  lifecycle: NativeSddWorkflowManagementDetail["lifecycle"],
): NativeSddWorkflowManagementDetail {
  return {
    kind: "native_sdd_delivery",
    specId: "spec-1",
    specSlug: "checkout",
    specName: "Checkout",
    attemptId: "attempt-2",
    pinnedRevisionId: "revision-8",
    pinnedRevisionNumber: 8,
    lifecycle,
    editable: lifecycle === "draft",
    isCurrentDefinition: true,
    specHref: "/specs/demo/checkout",
    builderHref: "/projects/demo/workflows?definition=wf-1",
    executionHref:
      lifecycle === "launched"
        ? "/projects/demo/session/workflow?execution=execution-1"
        : null,
    bindingRevision: 4,
    deltaBasisExecutionId: "execution-0",
    binding: { dispositions: [], claims: [] },
    dispositionCounts: {},
    unresolvedItems: [],
    criterionRows: [],
    claims: [],
    comments: [],
    nextAct: null,
    currentCandidate: null,
    currentCandidateHash: null,
    currentApproval: null,
    approvedBaseline: null,
    changes: {
      workflowSettings: false,
      contexts: false,
      tasks: false,
      edges: false,
      layout: false,
      dispositions: false,
      claims: false,
    },
    capabilities: {
      canPropose: lifecycle === "draft",
      canSignOff: lifecycle === "in_review",
      canReopen: lifecycle === "in_review" || lifecycle === "approved",
      canAbandon: ["draft", "in_review", "approved"].includes(lifecycle),
      canLaunch: lifecycle === "approved",
      refusals: {},
    },
  };
}

describe("ManagedDeliveryWorkflowHeader", () => {
  it("offers proposal and abandonment for a draft without generic deletion", async () => {
    const user = userEvent.setup();
    const onPropose = vi.fn();
    const onAbandon = vi.fn();
    render(
      <ManagedDeliveryWorkflowHeader
        management={management("draft")}
        definitionRevision={3}
        onPropose={onPropose}
        onAbandon={onAbandon}
      />,
    );

    expect(screen.getByRole("link", { name: "Checkout" })).toHaveAttribute(
      "href",
      "/specs/demo/checkout",
    );
    expect(screen.getByText("Draft")).toHaveAttribute("data-tone", "cyan");
    expect(
      screen.getByText(/spec r8 · definition r3 · attempt attempt-2/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Propose for review" }),
    );
    await user.click(screen.getByRole("button", { name: "Abandon plan" }));
    expect(onPropose).toHaveBeenCalledTimes(1);
    expect(onAbandon).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["in_review", ["Sign off", "Reopen", "Abandon plan"]],
    ["approved", ["Launch", "Reopen", "Abandon plan"]],
  ] as const)("offers the %s lifecycle actions", (lifecycle, actions) => {
    render(
      <ManagedDeliveryWorkflowHeader
        management={management(lifecycle)}
        definitionRevision={3}
        onSignOff={vi.fn()}
        onReopen={vi.fn()}
        onAbandon={vi.fn()}
        launchControl={<button type="button">Launch</button>}
      />,
    );
    for (const action of actions) {
      expect(screen.getByRole("button", { name: action })).toBeInTheDocument();
    }
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });

  it("links a launched candidate to its execution", () => {
    render(
      <ManagedDeliveryWorkflowHeader
        management={management("launched")}
        definitionRevision={3}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open execution" }),
    ).toHaveAttribute(
      "href",
      "/projects/demo/session/workflow?execution=execution-1",
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("leaves historical candidates inspectable with only the spec link", () => {
    render(
      <ManagedDeliveryWorkflowHeader
        management={management("superseded")}
        definitionRevision={3}
      />,
    );
    expect(screen.getByText("Superseded")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText(/Read-only/)).toBeInTheDocument();
  });
});
