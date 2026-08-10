// @vitest-environment jsdom
import { StrictMode } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SpecDetailView } from "@/lib/specs/queries";
import { specGatePresetSchema } from "@/lib/specs/schemas";
import type {
  SpecGatePreset,
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import SpecControlsPanel, {
  AbandonSpecPanel,
  ExecutionPanel,
  IntegrityBanner,
  PolicyAdmissionNotices,
  PolicyDialog,
  RenameSpecDialog,
  SpecIntegrityPanel,
} from "./SpecControls";
import {
  denseSpecControlsDetailFixture as denseExecutionFixture,
  draftingSpecControlsDetailFixture as draftingDetailFixture,
  policyAdmissionViewFixture,
  policyImpactDraftFixture,
  SPEC_CONTROLS_FIXTURE_NOW as NOW,
  specControlsDetailFixture as detailFixture,
} from "./SpecControls.fixtures";

const POLICY_CONFIRMATION_NAME = "Gate policy change — human confirmation";
const POLICY_CONFIRM_BUTTON = "Confirm policy change";
const LOOSENING_WARNING = /at least one gate becomes weaker/i;
const POLICY_IMPACT_NAME = "Impact of this change";
const CONSULTED_LIST = "Gates the next transition consults";
const ADDED_LIST = "Approvals added";
const REMOVED_LIST = "Approvals removed";
const UNAFFECTED_LIST = "Approvals unaffected";
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

// Preset dial vectors (requirements, design, plan, execution_start, delivery):
// contract-bearing (2,2,2,2,2) · exploratory (1,1,1,1,2) · fast-path (2,2,2,1,2).
// Only these three ordered pairs reduce a dial; the other three tighten.
const loosenedPresetPairs = new Set([
  "contract-bearing>exploratory",
  "contract-bearing>fast-path",
  "fast-path>exploratory",
]);

const presetDirectionMatrix = specGatePresetSchema.options.flatMap((from) =>
  specGatePresetSchema.options
    .filter((to) => to !== from)
    .map((to) => ({
      from,
      to,
      loosens: loosenedPresetPairs.has(`${from}>${to}`),
    })),
);

describe("PolicyDialog", () => {
  it("shows policy controls directly without an opening button", () => {
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Gate policy preset" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Change policy" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("radiogroup", { name: "Plan gate mode" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Execution start gate mode" }),
    ).toBeVisible();
  });

  it("raises selected preset helper text above tinted-background contrast", () => {
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={vi.fn()}
      />,
    );

    const description = screen.getByText(
      "Evergreen authoring, delivery-plan launch, and delivery require human gates.",
    );
    expect(description.closest('[data-selected="true"]')).toHaveClass(
      "[&_span[id]]:text-text-primary",
    );
  });

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

  it("submits a reset that tightens an override back to the preset default without confirmation", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{
          preset: "contract-bearing",
          overrides: { requirements: "notify" },
        }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
      />,
    );

    await user.click(screen.getByRole("button", { name: "↺ preset" }));

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onChangePolicy).toHaveBeenCalledTimes(1);
    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: { preset: "contract-bearing" },
      hardConfirmed: false,
    });
  });

  it("previews the pinned stage, the gates a tightened propose consults, added approvals, draft validity, and remaining lifecycle", async () => {
    const onChangePolicy = vi.fn();
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "exploratory" }}
        pending={false}
        error={null}
        onChangePolicy={onChangePolicy}
        openDraft={policyImpactDraftFixture("design")}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Contract-bearing/ }));

    const confirmation = screen.getByRole("alertdialog", {
      name: POLICY_CONFIRMATION_NAME,
    });
    const impact = within(confirmation).getByRole("region", {
      name: POLICY_IMPACT_NAME,
    });

    expect(within(impact).getByText("Design → Design")).toBeVisible();
    expect(within(impact).getByText("Pinned")).toBeVisible();
    expect(
      within(impact).getByText(/never restages an open draft/i),
    ).toBeVisible();
    expect(
      within(impact).getByText(/Propose the Design stage/i),
    ).toHaveTextContent("human sign-off required");

    expect(
      listLabels(within(impact).getByRole("list", { name: CONSULTED_LIST })),
    ).toEqual(["Requirements · Gate", "Design · Gate"]);
    expect(
      listLabels(within(impact).getByRole("list", { name: ADDED_LIST })),
    ).toEqual([
      "Requirements · Notify → Gate",
      "Design · Notify → Gate",
      "Execution start · Notify → Gate",
    ]);
    expect(
      listLabels(within(impact).getByRole("list", { name: UNAFFECTED_LIST })),
    ).toEqual(["Delivery · Gate → Gate"]);
    expect(
      within(impact).queryByRole("list", { name: REMOVED_LIST }),
    ).not.toBeInTheDocument();

    expect(within(impact).getByText(/Draft rev 4 stays valid/i)).toBeVisible();
    expect(
      listLabels(within(impact).getByRole("list", { name: LIFECYCLE_LIST })),
    ).toEqual(["Design · Gate", "Execution start · Gate", "Delivery · Gate"]);

    expect(onChangePolicy).not.toHaveBeenCalled();
    await user.click(
      within(confirmation).getByRole("button", {
        name: POLICY_CONFIRM_BUTTON,
      }),
    );
    expect(onChangePolicy).toHaveBeenCalledWith({
      proposedPolicy: { preset: "contract-bearing" },
      hardConfirmed: true,
    });
  });

  it("previews a loosening as an agent proposal that consults only the pinned stage", async () => {
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={vi.fn()}
        openDraft={policyImpactDraftFixture("design")}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Exploratory/ }));

    const impact = within(
      screen.getByRole("alertdialog", { name: POLICY_CONFIRMATION_NAME }),
    ).getByRole("region", { name: POLICY_IMPACT_NAME });

    expect(within(impact).getByText("Design → Design")).toBeVisible();
    expect(
      within(impact).getByText(/Propose the Design stage/i),
    ).toHaveTextContent("the agent may proceed");
    expect(
      listLabels(within(impact).getByRole("list", { name: CONSULTED_LIST })),
    ).toEqual(["Requirements · Notify", "Design · Notify"]);
    expect(
      listLabels(within(impact).getByRole("list", { name: REMOVED_LIST })),
    ).toEqual([
      "Requirements · Gate → Notify",
      "Design · Gate → Notify",
      "Execution start · Gate → Notify",
    ]);
    expect(
      within(impact).queryByRole("list", { name: ADDED_LIST }),
    ).not.toBeInTheDocument();
    expect(
      listLabels(within(impact).getByRole("list", { name: LIFECYCLE_LIST })),
    ).toEqual([
      "Design · Notify",
      "Execution start · Notify",
      "Delivery · Gate",
    ]);
  });

  it("previews a change with no open draft without claiming a stage or a lifecycle", async () => {
    const user = userEvent.setup();
    render(
      <PolicyDialog
        currentPolicy={{ preset: "contract-bearing" }}
        pending={false}
        error={null}
        onChangePolicy={vi.fn()}
        openDraft={null}
      />,
    );

    await user.click(screen.getByRole("radio", { name: /Fast path/ }));

    const impact = within(
      screen.getByRole("alertdialog", { name: POLICY_CONFIRMATION_NAME }),
    ).getByRole("region", { name: POLICY_IMPACT_NAME });

    expect(within(impact).getByText(/No open draft revision/i)).toBeVisible();
    expect(within(impact).queryByText("Pinned")).not.toBeInTheDocument();
    expect(
      within(impact).queryByRole("list", { name: CONSULTED_LIST }),
    ).not.toBeInTheDocument();
    expect(
      within(impact).queryByRole("list", { name: LIFECYCLE_LIST }),
    ).not.toBeInTheDocument();
    expect(
      listLabels(within(impact).getByRole("list", { name: REMOVED_LIST })),
    ).toEqual(["Execution start · Gate → Notify"]);
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
  it("renders scoped acceptance-criterion prose as markdown", async () => {
    const detail = detailFixture("running");
    const snapshot = detail.executionRevisionSnapshots[0];
    const criterion = snapshot?.elements.find(
      (entry) => entry.element.id === "criterion-1",
    );
    if (criterion?.version.payload.kind !== "criterion") {
      throw new Error("Execution fixture requires criterion-1");
    }
    criterion.version.payload.text =
      "The **selected task** remains pinned through `aliases`.";

    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const mergeGate = screen.getByRole("region", {
      name: "Merge gate for execution-1",
    });
    expect(
      await within(mergeGate).findByText("selected task", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(mergeGate).findByText("aliases", { selector: "code" }),
    ).toBeVisible();
  });

  it("routes a legacy requirements-only revision to DeliveryPlanAttempt authoring", () => {
    const detail = detailFixture();
    const approved = detail.currentApprovedRevision;
    if (approved === null) throw new Error("Approved fixture missing");
    const requirementsOnly: SpecDetailView = {
      ...detail,
      currentRevision: {
        ...approved,
        revision: { ...approved.revision, authoringStage: "requirements" },
      },
      currentApprovedRevision: {
        ...approved,
        revision: { ...approved.revision, authoringStage: "requirements" },
      },
    };

    render(
      <ExecutionPanel
        detail={requirementsOnly}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Launch from Delivery plan" }),
    ).toBeVisible();
    expect(screen.getByText(/approved DeliveryPlanAttempt/i)).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open Delivery plan" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?view=plan");
    expect(
      screen.queryByRole("button", { name: "Start execution" }),
    ).toBeNull();
  });

  it("routes an unlaunched spec to its delivery plan instead of offering evergreen scope selection", () => {
    const detail = denseExecutionFixture("none");
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const surface = screen.getByRole("region", {
      name: "Execution and merge",
    });
    expect(surface).toHaveClass("max-w-[1000px]");
    expect(
      within(surface).getByRole("heading", {
        name: "Execution — inside the workflow surface",
      }),
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("heading", {
        name: "Launch from Delivery plan",
      }),
    ).toBeInTheDocument();
    expect(
      within(surface).getByRole("link", { name: "Open Delivery plan" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?view=plan");
    expect(
      within(surface).queryByRole("textbox", { name: "Session name" }),
    ).not.toBeInTheDocument();
    expect(
      within(surface).queryByRole("button", { name: "Start execution" }),
    ).not.toBeInTheDocument();
    expect(
      within(surface).queryByTestId("execution-scope-validation"),
    ).not.toBeInTheDocument();
  });

  it("presents definition review as a provenance-locked workflow approval", async () => {
    const onApproveExecutionStart = vi.fn();
    const user = userEvent.setup();
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
        onApproveExecutionStart={onApproveExecutionStart}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const banner = screen.getByTestId("definition-review-banner");
    expect(banner).toHaveClass("before:from-amber");
    expect(
      within(banner).getByText("Definition awaiting approval"),
    ).toBeVisible();
    expect(banner).toHaveTextContent(
      "Generated from browser-proof-spec revision 1.",
    );
    expect(
      within(banner).getByRole("region", {
        name: "Contract-derived — provenance-locked",
      }),
    ).toHaveTextContent("read-only · owned by browser-proof-spec rev 1");
    const settings = within(banner).getByRole("region", {
      name: "Execution-only — editable",
    });
    expect(settings).toHaveTextContent("Isolation");
    expect(settings).toHaveTextContent("Validation");
    expect(settings).toHaveTextContent("Budgets");
    expect(
      within(banner).getByRole("link", { name: "Request changes" }),
    ).toHaveAttribute("href", "/specs/command-center/browser-proof-spec");

    await user.click(
      within(banner).getByRole("button", {
        name: "Approve definition & start",
      }),
    );
    expect(onApproveExecutionStart).toHaveBeenCalledWith({
      executionId: "execution-1",
    });
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
        onApproveExecutionStart={vi.fn()}
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
        onApproveExecutionStart={vi.fn()}
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

  it("renders the server-computed proof projection: row chips, kind chips, and the split counter", () => {
    render(
      <ExecutionPanel
        detail={denseExecutionFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const mergeGate = screen.getByRole("region", {
      name: "Merge gate for execution-1",
    });
    // The ?el=delivery deep link scrolls to and focuses this panel.
    expect(mergeGate).toHaveAttribute("id", "merge-gate");
    expect(mergeGate).toHaveAttribute("tabindex", "-1");
    // Per-criterion rows mirror deliveryProjection verbatim.
    expect(within(mergeGate).getByText("Proof recorded")).toBeVisible();
    expect(within(mergeGate).getAllByText("Waived").length).toBeGreaterThan(0);
    expect(
      within(mergeGate).getAllByText("Delivered elsewhere").length,
    ).toBeGreaterThan(0);
    expect(within(mergeGate).getAllByText("Test run")).toHaveLength(3);
    // Pre-merge proof standing is separated from the delivered-state counter.
    expect(
      within(mergeGate).getByText(
        "1/3 proof recorded · 1 waived · 1 external delivery",
      ),
    ).toBeVisible();
    expect(
      within(mergeGate).getByText(
        "Criteria count as proven once a gate-passed merge publishes — merged proof 1/3.",
      ),
    ).toBeVisible();
    expect(within(mergeGate).queryByText(/1\/3 proven ·/)).toBeNull();
  });

  it("shows Awaiting proof for a scoped criterion with no recorded proof", () => {
    render(
      <ExecutionPanel
        detail={detailFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    const mergeGate = screen.getByRole("region", {
      name: "Merge gate for execution-1",
    });
    expect(within(mergeGate).getByText("Awaiting proof")).toBeVisible();
    expect(
      within(mergeGate).getByText(
        "0/1 proof recorded · 0 waived · 0 external delivery",
      ),
    ).toBeVisible();
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
        onApproveExecutionStart={vi.fn()}
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
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
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
        onGrantWaiver={onGrantWaiver}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByText("Definition review")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open workflow definition" }),
    ).toHaveAttribute(
      "href",
      "/projects/command-center/workflows?definition=workflow-definition-1",
    );
    await user.click(screen.getByRole("button", { name: "Waive R1.1" }));
    const record = screen.getByRole("button", {
      name: "Record waiver for R1.1",
    });
    expect(record).toBeDisabled();
    await user.type(
      screen.getByRole("textbox", { name: "Waiver reason for R1.1" }),
      "Hardware capture is unavailable; Alex reviewed the equivalent trace.",
    );
    await user.click(record);

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
        onApproveExecutionStart={vi.fn()}
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

  it("approves execution start for a definition-review run when the execution-start dial is a gate", async () => {
    const onApproveExecutionStart = vi.fn();
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
        onApproveExecutionStart={onApproveExecutionStart}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.getByText(/won't run until a human approves/),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Approve definition & start" }),
    );

    expect(onApproveExecutionStart).toHaveBeenCalledWith({
      executionId: "execution-1",
    });
  });

  it("keeps the approval recovery action after an unlaunched gate definition is switched to notify", () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    detail.spec.gatePolicy = {
      preset: "contract-bearing",
      overrides: { execution_start: "notify" },
    };
    Object.assign(execution, { definitionApprovalRequired: true });
    execution.workflowExecutionId = null;

    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Approve definition & start" }),
    ).toBeVisible();
  });

  it("starts a Notify-compiled definition directly with its immutable revision", async () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    detail.spec.gatePolicy = {
      preset: "contract-bearing",
      overrides: { execution_start: "notify" },
    };
    Object.assign(execution, {
      definitionApprovalRequired: false,
      workflowDefinitionRevision: 4,
    });
    const onStartPreparedWorkflow = vi.fn();

    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onStartPreparedWorkflow={onStartPreparedWorkflow}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByText("Definition ready to start")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: "Start workflow" }),
    );
    expect(onStartPreparedWorkflow).toHaveBeenCalledWith({
      sessionName: "native-sdd-run",
      definitionId: "workflow-definition-1",
      definitionRevision: 4,
    });
  });

  it("redirects an incomplete legacy launch target to a seeded delivery plan", () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    Object.assign(execution, {
      definitionApprovalRequired: false,
      workflowDefinitionRevision: null,
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
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      /cctl spec plan open native-sdd --seed-from last.*cctl spec start native-sdd/i,
    );
  });

  it("renders the recorded execution-start approval without claiming the run started", () => {
    const detail = detailFixture("definition_review");
    detail.gateAdmissions = [
      policyAdmissionViewFixture({
        id: "admission-start-1",
        gate: "execution_start",
        basis: "human_approval",
        approvalId: "approval-start-1",
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
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve definition & start" }),
    ).toBeNull();
    expect(screen.getByText("Execution start approved")).toBeInTheDocument();
    expect(screen.getByText(/approval stays recorded/)).toBeInTheDocument();
  });

  it("links the workflow run to the pinned session's workflow page once it exists", () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    execution.state = "running";
    execution.workflowExecutionId = "workflow-execution-9";
    render(
      <ExecutionPanel
        detail={detail}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
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
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={onGrantGateApproval}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Approve delivery for merge" }),
    );

    expect(onGrantGateApproval).toHaveBeenCalledWith({
      executionId: "execution-1",
      revisionId: "revision-1",
    });
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
        onApproveExecutionStart={vi.fn()}
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
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Approve delivery for merge" }),
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
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={onCaptureScopeAmendment}
        onAbandonExecution={vi.fn()}
      />,
    );

    const discovery = screen.getByRole("region", {
      name: "Non-blocking discovery",
    });
    const capture = within(discovery).getByRole("button", {
      name: "Record discovery",
    });
    expect(capture).toBeDisabled();
    await user.type(
      within(discovery).getByRole("textbox", { name: "Discovery title" }),
      "Handle the discovered migration",
    );
    expect(capture).toBeDisabled();
    await user.type(
      within(discovery).getByRole("textbox", {
        name: "Discovery instructions",
      }),
      "Write the follow-up migration.",
    );
    expect(within(discovery).getByText(/keeps its pinned scope/)).toBeVisible();
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
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={onCaptureScopeAmendment}
        onAbandonExecution={vi.fn()}
      />,
    );

    const replan = screen.getByRole("region", { name: "Blocking replan" });
    await user.type(
      within(replan).getByRole("textbox", { name: "Replan task title" }),
      "Handle the discovered migration",
    );
    await user.type(
      within(replan).getByRole("textbox", {
        name: "Replan task instructions",
      }),
      "Write the follow-up migration.",
    );

    const capture = within(replan).getByRole("button", {
      name: "Replan execution",
    });
    expect(capture).toBeDisabled();
    await user.type(
      within(replan).getByRole("textbox", { name: "Blocking reason" }),
      "The migration must land before this run can proceed.",
    );
    await user.click(capture);
    await user.click(
      screen.getByRole("button", {
        name: "Abandon execution-1 and open seeded plan",
      }),
    );

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

  it("uses the blocking replan coordinator instead of a standalone running-execution abandon form", () => {
    render(
      <ExecutionPanel
        detail={detailFixture("running")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("textbox", { name: "Abandonment reason" }),
    ).toBeNull();
    expect(
      screen.getByRole("region", { name: "Blocking replan" }),
    ).toBeVisible();
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
        onApproveExecutionStart={vi.fn()}
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

  it("does not offer capture during definition review, mirroring the server's running-only refusal", () => {
    render(
      <ExecutionPanel
        detail={detailFixture("definition_review")}
        projectName="command-center"
        pendingAction={null}
        error={null}
        onGrantWaiver={vi.fn()}
        onSetDisposition={vi.fn()}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
        onCaptureScopeAmendment={vi.fn()}
        onAbandonExecution={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("region", { name: "Post-launch capture" }),
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
        onGrantWaiver={vi.fn()}
        onSetDisposition={onSetDisposition}
        onGrantGateApproval={vi.fn()}
        onApproveExecutionStart={vi.fn()}
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

  it("renders nothing when every admission has a human approval basis", () => {
    const { container } = render(
      <PolicyAdmissionNotices
        admissions={[
          policyAdmissionViewFixture({
            basis: "human_approval",
            approvalId: "approval-1",
          }),
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe("IntegrityBanner", () => {
  it("shows a quiet result surface when verification passes", () => {
    render(
      <IntegrityBanner
        report={{
          ok: true,
          checkedRevisionIds: ["revision-1"],
          mismatches: [],
          consistencyFindings: [],
        }}
        isPending={false}
        error={null}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("Integrity intact");
    expect(screen.getByRole("status")).toHaveTextContent(
      "1 approved revision verified",
    );
  });

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

describe("AbandonSpecPanel", () => {
  const SPEC_ABANDON_TRIGGER = "Abandon whole spec";
  const SPEC_ABANDON_CONFIRM = "Abandon spec permanently";
  const SPEC_ABANDON_REASON = "Spec abandonment reason";

  it("offers the whole-spec action under its own name, distinct from execution abandonment", () => {
    render(
      <AbandonSpecPanel
        slug="native-sdd"
        abandonedAt={null}
        abandonedReason={null}
        pending={false}
        error={null}
        onAbandonSpec={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Abandon execution" }),
    ).not.toBeInTheDocument();
  });

  it("opens a confirmation naming the spec instead of submitting on the first click", async () => {
    const onAbandonSpec = vi.fn();
    const user = userEvent.setup();
    render(
      <AbandonSpecPanel
        slug="native-sdd"
        abandonedAt={null}
        abandonedReason={null}
        pending={false}
        error={null}
        onAbandonSpec={onAbandonSpec}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    );

    expect(onAbandonSpec).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", {
      name: /native-sdd/,
    });
    expect(
      within(confirmation).getByRole("button", { name: SPEC_ABANDON_CONFIRM }),
    ).toBeDisabled();
  });

  it("dispatches the abandonment with its reason only from the confirm action", async () => {
    const onAbandonSpec = vi.fn();
    const user = userEvent.setup();
    render(
      <AbandonSpecPanel
        slug="native-sdd"
        abandonedAt={null}
        abandonedReason={null}
        pending={false}
        error={null}
        onAbandonSpec={onAbandonSpec}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: /native-sdd/,
    });
    await user.type(
      within(confirmation).getByRole("textbox", { name: SPEC_ABANDON_REASON }),
      "  Superseded by the ticket-native rewrite.  ",
    );
    expect(onAbandonSpec).not.toHaveBeenCalled();

    await user.click(
      within(confirmation).getByRole("button", { name: SPEC_ABANDON_CONFIRM }),
    );

    expect(onAbandonSpec).toHaveBeenCalledTimes(1);
    expect(onAbandonSpec).toHaveBeenCalledWith({
      reason: "Superseded by the ticket-native rewrite.",
    });
  });

  it("dispatches nothing when the confirmation is cancelled", async () => {
    const onAbandonSpec = vi.fn();
    const user = userEvent.setup();
    render(
      <AbandonSpecPanel
        slug="native-sdd"
        abandonedAt={null}
        abandonedReason={null}
        pending={false}
        error={null}
        onAbandonSpec={onAbandonSpec}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    );
    await user.type(
      screen.getByRole("textbox", { name: SPEC_ABANDON_REASON }),
      "Superseded by the ticket-native rewrite.",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onAbandonSpec).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    });

    // A reopened confirmation must not carry the abandoned reason forward.
    await user.click(
      screen.getByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    );
    expect(
      screen.getByRole("textbox", { name: SPEC_ABANDON_REASON }),
    ).toHaveValue("");
  });

  it("replaces the control with the recorded outcome once the spec is abandoned", () => {
    render(
      <AbandonSpecPanel
        slug="native-sdd"
        abandonedAt={NOW}
        abandonedReason="Superseded by the ticket-native rewrite."
        pending={false}
        error={null}
        onAbandonSpec={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", { name: SPEC_ABANDON_TRIGGER }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Superseded by the ticket-native rewrite."),
    ).toBeVisible();
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

describe("SpecControlsPanel execution-start refusal", () => {
  let api: FetchFixture;

  beforeEach(() => {
    api = installFetchFixture();
  });

  afterEach(() => {
    api.restore();
  });

  it("renders the unmet condition and recovery instruction beside the definition approval control", async () => {
    const detail = detailFixture("definition_review");
    const approvePath = `/api/specs/command-center/${detail.spec.slug}/actions/approve-execution-start`;
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    api.reply("POST", approvePath, {
      status: 409,
      json: {
        code: "gate_blocked",
        unmetConditions: [
          "The session has no workflow execution awaiting definition approval.",
        ],
        instruction:
          "Start the compiled workflow from the session first, then approve execution start.",
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

    const banner = screen.getByTestId("definition-review-banner");
    await user.click(
      within(banner).getByRole("button", {
        name: "Approve definition & start",
      }),
    );

    await waitFor(() => {
      expect(api.requestsTo("POST", approvePath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", approvePath)[0]?.jsonBody).toEqual({
      executionId: "execution-1",
    });

    const refusal = await within(banner).findByRole("alert");
    expect(refusal).toHaveTextContent(
      "The session has no workflow execution awaiting definition approval.",
    );
    expect(refusal).toHaveTextContent(
      "Start the compiled workflow from the session first, then approve execution start.",
    );
  });

  it("starts a Notify-compiled definition from Studio with the pinned revision", async () => {
    const detail = detailFixture("definition_review");
    const execution = detail.executions[0];
    if (execution === undefined) throw new Error("Execution fixture missing");
    detail.spec.gatePolicy = {
      preset: "contract-bearing",
      overrides: { execution_start: "notify" },
    };
    execution.definitionApprovalRequired = false;
    execution.workflowDefinitionRevision = 7;
    const startPath =
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow";
    api.pending(
      "POST",
      `/api/specs/command-center/${detail.spec.slug}/actions/verify`,
    );
    api.reply("POST", startPath, { status: 202, json: {} });

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="execution"
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Start workflow" }),
    );

    await waitFor(() => {
      expect(api.requestsTo("POST", startPath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", startPath)[0]?.jsonBody).toEqual({
      definitionId: "workflow-definition-1",
      definitionRevision: 7,
      tier: "project",
    });
    expect(await screen.findByText("Workflow started")).toBeVisible();
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

  it("posts the canonical amendment without caller attribution and renders the durable event", async () => {
    const detail = runningDpaDetail();
    const eventsPath =
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow/events";
    const amendPath =
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow/amend";
    const amendmentEvent = {
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
    };
    api.reply("GET", eventsPath, () => ({
      json: {
        events:
          api.requestsTo("POST", amendPath).length === 0
            ? []
            : [
                {
                  occurredAt: NOW,
                  event: amendmentEvent,
                  preReset: false,
                },
              ],
      },
    }));
    api.json("POST", amendPath, {
      amended: 1,
      liveRevision: 3,
      policyBasis: "human_operator",
      addedContextIds: [],
      addedTaskIds: ["verify-added-path"],
      addedEdgeIds: [],
      previousWorkingDefinitionHash: "sha256:old",
      workingDefinitionHash: "sha256:new",
    });
    const user = userEvent.setup();

    renderWithQuery(
      <SpecControlsPanel
        detail={detail}
        projectName="command-center"
        surface="execution"
      />,
    );
    await waitFor(() => {
      expect(api.requestsTo("GET", eventsPath)).toHaveLength(1);
    });

    const amend = screen.getByRole("region", { name: "Amend current run" });
    await user.type(
      within(amend).getByRole("textbox", { name: "Amendment rationale" }),
      "Add live verification.",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task id" }),
      "verify-added-path",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Target context id" }),
      "capture-studio",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task title" }),
      "Verify the added path",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task instructions" }),
      "Exercise the production route.",
    );
    await user.click(
      within(amend).getByRole("button", { name: "Queue task addition" }),
    );
    const eventRequestCountBeforeAmend = api.requestsTo(
      "GET",
      eventsPath,
    ).length;
    await user.click(
      within(amend).getByRole("button", { name: "Apply amendment" }),
    );

    await waitFor(() => {
      expect(api.requestsTo("POST", amendPath)).toHaveLength(1);
    });
    expect(api.requestsTo("POST", amendPath)[0]?.jsonBody).toEqual({
      reason: "Add live verification.",
      operations: [
        {
          type: "add-task",
          id: "verify-added-path",
          contextId: "capture-studio",
          title: "Verify the added path",
          instructions: "Exercise the production route.",
        },
      ],
    });
    await waitFor(() => {
      expect(api.requestsTo("GET", eventsPath).length).toBeGreaterThan(
        eventRequestCountBeforeAmend,
      );
    });
    expect(
      await within(amend).findByText("Durable amendment event"),
    ).toBeVisible();
    expect(
      await within(amend).findByText(/human · Add live verification/),
    ).toBeVisible();
    expect(within(amend).getByText(/sha256:old/)).toBeVisible();
    expect(within(amend).getByText(/sha256:new/)).toBeVisible();
  });

  it("renders the production unlaunched redirect and non-running amendment remedy inline", async () => {
    const unlaunched = detailFixture();
    const capturePath = `/api/specs/command-center/${unlaunched.spec.slug}/actions/capture-scope-amendment`;
    api.reply("POST", capturePath, {
      status: 409,
      json: {
        code: "gate_blocked",
        unmetConditions: [
          "Delivery plan attempt attempt-3 is approved and has launched no execution.",
        ],
        instruction:
          "Nothing was captured. Add the discovered work to the plan itself with `cctl spec plan reopen native-sdd --reason <why>`.",
      },
    });
    const user = userEvent.setup();
    const rendered = renderWithQuery(
      <SpecControlsPanel
        detail={unlaunched}
        projectName="command-center"
        surface="execution"
      />,
    );
    const discovery = screen.getByRole("region", {
      name: "Non-blocking discovery",
    });
    await user.type(
      within(discovery).getByRole("textbox", { name: "Discovery title" }),
      "Document the migration edge",
    );
    await user.type(
      within(discovery).getByRole("textbox", {
        name: "Discovery instructions",
      }),
      "Carry the edge into the plan.",
    );
    await user.click(
      within(discovery).getByRole("button", { name: "Record discovery" }),
    );

    expect(await within(discovery).findByRole("alert")).toHaveTextContent(
      "cctl spec plan reopen native-sdd",
    );
    expect(api.requestsTo("POST", capturePath)[0]?.jsonBody).not.toHaveProperty(
      "executionId",
    );
    expect(
      within(discovery).getByRole("link", { name: "Open delivery plan" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?view=plan");

    rendered.unmount();
    api.restore();
    api = installFetchFixture();
    const running = runningDpaDetail();
    const eventsPath =
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow/events";
    const amendPath =
      "/api/projects/command-center/sessions/native-sdd-run/graph-workflow/amend";
    api.json("GET", eventsPath, { events: [] });
    api.reply("POST", amendPath, {
      status: 409,
      json: {
        code: "not_running",
        error:
          'Execution "workflow-execution-1" is paused; only a running execution can be amended. Nothing was applied.',
        instruction:
          "Resume the run with `cctl workflow live resume` and re-run the amendment, or plan the work into the next attempt with `cctl spec plan open --seed-from last`.",
      },
    });
    renderWithQuery(
      <SpecControlsPanel
        detail={running}
        projectName="command-center"
        surface="execution"
      />,
    );
    const amend = screen.getByRole("region", { name: "Amend current run" });
    await user.type(
      within(amend).getByRole("textbox", { name: "Amendment rationale" }),
      "Add live verification.",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task id" }),
      "verify-added-path",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Target context id" }),
      "capture-studio",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task title" }),
      "Verify the added path",
    );
    await user.type(
      within(amend).getByRole("textbox", { name: "Task instructions" }),
      "Exercise the production route.",
    );
    await user.click(
      within(amend).getByRole("button", { name: "Queue task addition" }),
    );
    await user.click(
      within(amend).getByRole("button", { name: "Apply amendment" }),
    );

    expect(await within(amend).findByRole("alert")).toHaveTextContent(
      "cctl workflow live resume",
    );
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
