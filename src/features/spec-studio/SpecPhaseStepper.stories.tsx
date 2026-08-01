import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specDetailViewSchema, type SpecDetailView } from "@/lib/specs/queries";
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

const AUTHORING_STAGES = ["requirements", "design", "plan"] as const;

function parsedDetail(detail: SpecDetailView): SpecDetailView {
  return specDetailViewSchema.parse(detail);
}

function revisionFor(
  base: SpecRevision,
  number: number,
  authoringStage: SpecAuthoringStage,
  state: SpecRevisionState,
): SpecRevision {
  return {
    ...base,
    id: `stepper-revision-${number}`,
    number,
    state,
    authoringStage,
    basedOnRevisionId: number === 1 ? null : `stepper-revision-${number - 1}`,
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
    throw new Error("Phase stepper story fixture is missing its snapshot");
  }

  const stageIndex = AUTHORING_STAGES.indexOf(stage);
  const approvedRevisions = AUTHORING_STAGES.slice(0, stageIndex).map(
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

  return parsedDetail({
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
  });
}

function initializedDetail(): SpecDetailView {
  const base = specControlsDetailFixture();
  return parsedDetail({
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
  });
}

function runningDetail(): SpecDetailView {
  const detail = specControlsDetailFixture("running");
  const execution = detail.executions[0];
  const statusExecution = detail.status.executions[0];
  if (execution === undefined || statusExecution === undefined) {
    throw new Error("Phase stepper story fixture is missing its execution");
  }

  return parsedDetail({
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
  });
}

function awaitingMergeDetail(): SpecDetailView {
  const detail = runningDetail();
  const statusExecution = detail.status.executions[0];
  if (statusExecution === undefined) {
    throw new Error(
      "Phase stepper story fixture is missing its status execution",
    );
  }
  return parsedDetail({
    ...detail,
    status: {
      ...detail.status,
      executions: [
        {
          ...statusExecution,
          workflowStatus: "completed",
        },
      ],
    },
  });
}

function deliveredDetail(): SpecDetailView {
  const detail = runningDetail();
  const execution = detail.executions[0];
  const statusExecution = detail.status.executions[0];
  if (execution === undefined || statusExecution === undefined) {
    throw new Error("Phase stepper story fixture is missing its execution");
  }

  return parsedDetail({
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
      delivery: { allWaived: false, provenCount: 1, totalInScope: 1 },
    },
  });
}

function abandonedDetail(): SpecDetailView {
  const detail = specControlsDetailFixture();
  return parsedDetail({
    ...detail,
    spec: {
      ...detail.spec,
      abandonedAt: SPEC_CONTROLS_FIXTURE_NOW,
      abandonedReason: "Superseded by the platform contract.",
    },
    status: { ...detail.status, phase: { primary: "abandoned" } },
  });
}

function concurrentAuthoringDetail(): SpecDetailView {
  const detail = runningDetail();
  const template = detail.revisions[0];
  const elements = detail.currentRevision?.elements;
  if (template === undefined || elements === undefined) {
    throw new Error("Phase stepper story fixture is missing its snapshot");
  }
  const amendment = revisionFor(template, 2, "design", "proposed");

  return parsedDetail({
    ...detail,
    revisions: [template, amendment],
    currentRevision: { revision: amendment, elements },
    status: {
      ...detail.status,
      phase: { primary: "executing", authoringFacet: "in_review" },
    },
  });
}

const lifecycleVariants = [
  { name: "Initialized", detail: initializedDetail() },
  {
    name: "Requirements draft",
    detail: authoringDetail("requirements", "draft"),
  },
  {
    name: "Requirements review",
    detail: authoringDetail("requirements", "proposed"),
  },
  { name: "Design draft", detail: authoringDetail("design", "draft") },
  { name: "Design review", detail: authoringDetail("design", "proposed") },
  { name: "Plan draft", detail: authoringDetail("plan", "draft") },
  { name: "Plan review", detail: authoringDetail("plan", "proposed") },
  { name: "Ready", detail: parsedDetail(specControlsDetailFixture()) },
  {
    name: "Definition review",
    detail: parsedDetail(specControlsDetailFixture("definition_review")),
  },
  { name: "Running", detail: runningDetail() },
  { name: "Ready to merge", detail: awaitingMergeDetail() },
  { name: "Concurrent design review", detail: concurrentAuthoringDetail() },
  { name: "Delivered", detail: deliveredDetail() },
  { name: "Abandoned", detail: abandonedDetail() },
] satisfies ReadonlyArray<{ name: string; detail: SpecDetailView }>;

const meta = {
  title: "Specs/Studio/Phase Stepper",
  component: SpecPhaseStepper,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: { detail: parsedDetail(specControlsDetailFixture()) },
} satisfies Meta<typeof SpecPhaseStepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LifecycleVariants: Story = {
  render: () => (
    <main className="h-screen overflow-y-auto bg-bg-void py-xl">
      <div className="mx-auto grid max-w-[calc(var(--spacing-3xl)*28)] gap-xl">
        {lifecycleVariants.map((variant) => (
          <section key={variant.name}>
            <h2 className="mx-xl mt-0 mb-sm font-mono text-xs font-bold tracking-[0.08em] text-text-secondary uppercase max-768:mx-md">
              {variant.name}
            </h2>
            <SpecPhaseStepper detail={variant.detail} />
          </section>
        ))}
      </div>
    </main>
  ),
};

export const MobileOverflow: Story = {
  args: { detail: concurrentAuthoringDetail() },
  render: (args) => (
    <main className="min-h-screen bg-bg-void">
      <SpecPhaseStepper {...args} />
    </main>
  ),
  parameters: {
    viewport: { defaultViewport: "mobile1" },
  },
};
