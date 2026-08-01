// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { SpecDetailView } from "@/lib/specs/queries";
import type {
  SpecAuthoringStage,
  SpecRevision,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import SpecPhaseStepper from "./SpecPhaseStepper";

const STAGES = ["requirements", "design", "plan"] as const;

function revisionFor(
  base: SpecRevision,
  number: number,
  authoringStage: SpecAuthoringStage,
  state: SpecRevisionState,
): SpecRevision {
  return {
    ...base,
    id: `revision-${number}`,
    number,
    state,
    authoringStage,
    basedOnRevisionId: number === 1 ? null : `revision-${number - 1}`,
    proposedAt: state === "draft" ? null : SPEC_CONTROLS_FIXTURE_NOW,
    approvedAt: state === "approved" ? SPEC_CONTROLS_FIXTURE_NOW : null,
  };
}

function authoringDetail(
  stage: SpecAuthoringStage,
  state: "draft" | "proposed",
): SpecDetailView {
  const base = specControlsDetailFixture();
  const template = base.revisions[0];
  const elements = base.currentRevision?.elements;
  if (template === undefined || elements === undefined) {
    throw new Error("Spec phase fixture is missing its revision snapshot");
  }

  const stageIndex = STAGES.indexOf(stage);
  const approvedRevisions = STAGES.slice(0, stageIndex).map(
    (approvedStage, index) =>
      revisionFor(template, index + 1, approvedStage, "approved"),
  );
  const currentRevision = revisionFor(
    template,
    approvedRevisions.length + 1,
    stage,
    state,
  );
  const currentApprovedRevision = approvedRevisions.at(-1) ?? null;

  return {
    ...base,
    revisions: [...approvedRevisions, currentRevision],
    baseRevision:
      currentApprovedRevision === null
        ? null
        : { revision: currentApprovedRevision, elements },
    currentRevision: { revision: currentRevision, elements },
    currentApprovedRevision:
      currentApprovedRevision === null
        ? null
        : { revision: currentApprovedRevision, elements },
    executionRevisionSnapshots: [],
    status: {
      ...base.status,
      phase: {
        primary: state === "draft" ? "draft" : "in_review",
        authoringStage: stage,
      },
    },
  };
}

function initializedDetail(): SpecDetailView {
  const base = specControlsDetailFixture();
  return {
    ...base,
    revisions: [],
    baseRevision: null,
    currentRevision: null,
    currentApprovedRevision: null,
    executionRevisionSnapshots: [],
    status: {
      ...base.status,
      phase: { primary: "draft", authoringStage: "requirements" },
    },
  };
}

function runningDetail(): SpecDetailView {
  const detail = specControlsDetailFixture("running");
  const execution = detail.executions[0];
  const statusExecution = detail.status.executions[0];
  if (execution === undefined || statusExecution === undefined) {
    throw new Error("Spec phase fixture is missing its execution");
  }

  return {
    ...detail,
    executions: [
      {
        ...execution,
        workflowExecutionId: "workflow-execution-1",
      },
    ],
    elementStatuses: {
      ...detail.elementStatuses,
      tasks: [
        {
          elementId: "task-1",
          status: { status: "completed", claimEvidenceIds: [] },
        },
      ],
    },
    status: {
      ...detail.status,
      executions: [
        {
          ...statusExecution,
          workflowExecutionId: "workflow-execution-1",
          workflowStatus: "running",
        },
      ],
    },
  };
}

function step(name: string): HTMLElement {
  return screen.getByRole("listitem", { name: new RegExp(`^${name}:`) });
}

describe("SpecPhaseStepper", () => {
  it("presents initialized specs as an ordered, horizontally scrollable lifecycle", () => {
    render(<SpecPhaseStepper detail={initializedDetail()} />);

    const region = screen.getByRole("region", {
      name: "Spec lifecycle progress",
    });
    const lifecycle = within(region).getByRole("list", {
      name: "Spec lifecycle",
    });

    expect(within(lifecycle).getAllByRole("listitem")).toHaveLength(5);
    expect(region).toHaveClass("overflow-x-auto");
    expect(step("Requirements")).toHaveAttribute("aria-current", "step");
    expect(step("Requirements")).toHaveAttribute("data-state", "draft");
    expect(step("Requirements")).toHaveTextContent("agent drafting");
    expect(step("Design")).toHaveTextContent("starts after requirements");
    expect(step("Execute")).toHaveTextContent("locked until plan approved");
    expect(screen.getByText(/Spec initialized/)).toHaveTextContent(
      "The agent drafts the requirements contract first",
    );
  });

  it.each([
    ["requirements", "draft", "Requirements", "draft", "rev 1 drafting"],
    ["requirements", "proposed", "Requirements", "review", "rev 1 in review"],
    ["design", "draft", "Design", "draft", "rev 2 drafting"],
    ["design", "proposed", "Design", "review", "rev 2 in review"],
    ["plan", "draft", "Plan", "draft", "rev 3 drafting"],
    ["plan", "proposed", "Plan", "review", "rev 3 in review"],
  ] as const)(
    "derives %s %s progress from the revision history",
    (stage, revisionState, currentLabel, visualState, statusText) => {
      render(
        <SpecPhaseStepper detail={authoringDetail(stage, revisionState)} />,
      );

      const currentStep = step(currentLabel);
      expect(currentStep).toHaveAttribute("aria-current", "step");
      expect(currentStep).toHaveAttribute("data-state", visualState);
      expect(currentStep).toHaveTextContent(statusText);

      if (stage !== "requirements") {
        expect(step("Requirements")).toHaveAttribute("data-state", "done");
      }
      if (stage === "plan") {
        expect(step("Design")).toHaveAttribute("data-state", "done");
      }
    },
  );

  it("makes an approved plan ready for scoped execution", () => {
    render(<SpecPhaseStepper detail={specControlsDetailFixture()} />);

    expect(step("Requirements")).toHaveAttribute("data-state", "done");
    expect(step("Design")).toHaveAttribute("data-state", "done");
    expect(step("Plan")).toHaveTextContent("approved rev 1 · 1 task");
    expect(step("Execute")).toHaveAttribute("data-state", "ready");
    expect(step("Execute")).toHaveAttribute("aria-current", "step");
    expect(step("Execute")).toHaveTextContent("ready — scope selection");
    expect(
      screen.getByText(/All authoring stages are approved/),
    ).toHaveTextContent("revision 1");
  });

  it("distinguishes execution definition review from a running workflow", () => {
    const { rerender } = render(
      <SpecPhaseStepper
        detail={specControlsDetailFixture("definition_review")}
      />,
    );

    expect(step("Execute")).toHaveAttribute("data-state", "definition_review");
    expect(step("Execute")).toHaveTextContent("definition review · rev 1");
    expect(screen.getByText(/Execution definition/)).toHaveTextContent(
      "awaits review",
    );

    rerender(<SpecPhaseStepper detail={runningDetail()} />);

    expect(step("Execute")).toHaveAttribute("data-state", "running");
    expect(step("Execute")).toHaveTextContent("running · 1/1 task done");
    expect(screen.getByText(/Execution is running/)).toHaveTextContent(
      "pinned revision 1",
    );
  });

  it("moves a completed workflow to the delivery step while its session awaits merge", () => {
    const detail = runningDetail();
    const statusExecution = detail.status.executions[0];
    if (statusExecution === undefined) {
      throw new Error("Spec phase fixture is missing its status execution");
    }
    detail.status.executions = [
      { ...statusExecution, workflowStatus: "completed" },
    ];

    render(<SpecPhaseStepper detail={detail} />);

    expect(step("Execute")).toHaveAttribute("data-state", "done");
    expect(step("Execute")).toHaveTextContent(
      "workflow complete · 1/1 task done",
    );
    expect(step("Deliver")).toHaveAttribute("data-state", "ready");
    expect(step("Deliver")).toHaveAttribute("aria-current", "step");
    expect(step("Deliver")).toHaveTextContent("ready — merge session");
    expect(screen.getByText(/Workflow complete for/)).toHaveTextContent(
      "Merge session native-sdd-run to its delivery target",
    );
    expect(screen.queryByText(/Execution is running/)).toBeNull();
  });

  it("keeps a concurrent authoring review visible without displacing execution", () => {
    const detail = runningDetail();
    const template = detail.revisions[0];
    const elements = detail.currentRevision?.elements;
    if (template === undefined || elements === undefined) {
      throw new Error("Spec phase fixture is missing its revision snapshot");
    }
    const amendment = revisionFor(template, 2, "design", "proposed");

    render(
      <SpecPhaseStepper
        detail={{
          ...detail,
          revisions: [template, amendment],
          currentRevision: { revision: amendment, elements },
          status: {
            ...detail.status,
            phase: {
              primary: "executing",
              authoringFacet: "in_review",
            },
          },
        }}
      />,
    );

    expect(step("Design")).toHaveAttribute("data-state", "review");
    expect(step("Design")).toHaveTextContent("rev 2 in review");
    expect(step("Execute")).toHaveAttribute("data-state", "running");
    expect(step("Execute")).toHaveAttribute("aria-current", "step");
    expect(step("Design")).not.toHaveAttribute("aria-current");
    expect(screen.getByText(/Execution is running/)).toHaveTextContent(
      "Design rev 2 also awaits review",
    );
  });

  it("shows delivery completion from execution and proof projections", () => {
    const detail = runningDetail();
    const execution = detail.executions[0];
    const statusExecution = detail.status.executions[0];
    if (execution === undefined || statusExecution === undefined) {
      throw new Error("Spec phase fixture is missing its execution");
    }

    render(
      <SpecPhaseStepper
        detail={{
          ...detail,
          executions: [
            {
              ...execution,
              state: "delivered",
              deliveredAt: SPEC_CONTROLS_FIXTURE_NOW,
            },
          ],
          status: {
            ...detail.status,
            phase: { primary: "delivered" },
            executions: [
              {
                ...statusExecution,
                state: "delivered",
                workflowStatus: "completed",
              },
            ],
            delivery: {
              allWaived: false,
              provenCount: 1,
              totalInScope: 1,
            },
          },
        }}
      />,
    );

    expect(step("Execute")).toHaveAttribute("data-state", "done");
    expect(step("Deliver")).toHaveAttribute("data-state", "done");
    expect(step("Deliver")).toHaveAttribute("aria-current", "step");
    expect(step("Deliver")).toHaveTextContent("1/1 criterion proven");
    expect(screen.getByText(/Delivered:/)).toHaveTextContent(
      "1/1 in-scope criterion proven",
    );
  });

  it("reports an all-waived delivery without claiming criteria were proven", () => {
    const detail = specControlsDetailFixture();

    render(
      <SpecPhaseStepper
        detail={{
          ...detail,
          status: {
            ...detail.status,
            phase: { primary: "delivered" },
            delivery: {
              allWaived: true,
              provenCount: 0,
              totalInScope: 2,
            },
          },
        }}
      />,
    );

    expect(step("Deliver")).toHaveTextContent("2 criteria waived");
    expect(screen.getByText(/Delivered:/)).toHaveTextContent(
      "all 2 in-scope criteria waived",
    );
  });

  it("marks the interrupted lifecycle stage when a spec is abandoned", () => {
    const detail = specControlsDetailFixture();

    render(
      <SpecPhaseStepper
        detail={{
          ...detail,
          spec: {
            ...detail.spec,
            abandonedAt: SPEC_CONTROLS_FIXTURE_NOW,
            abandonedReason: "Superseded by the platform contract.",
          },
          status: {
            ...detail.status,
            phase: { primary: "abandoned" },
          },
        }}
      />,
    );

    expect(step("Execute")).toHaveAttribute("data-state", "abandoned");
    expect(step("Execute")).toHaveAttribute("aria-current", "step");
    expect(step("Deliver")).toHaveAttribute("data-state", "locked");
    expect(screen.getByText(/Abandoned:/)).toHaveTextContent(
      "Superseded by the platform contract.",
    );
  });
});
