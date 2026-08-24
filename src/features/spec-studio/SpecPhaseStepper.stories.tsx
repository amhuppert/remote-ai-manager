import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { specDetailViewSchema, type SpecDetailView } from "@/lib/specs/queries";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import type {
  SpecAuthoringStage,
  SpecRevision,
  SpecRevisionSnapshot,
  SpecRevisionState,
} from "@/lib/specs/schemas";

import {
  SPEC_CONTROLS_FIXTURE_NOW,
  specControlsDetailFixture,
} from "./SpecControls.fixtures";
import SpecPhaseStepper from "./SpecPhaseStepper";
import { reviewView } from "./delivery-plan-review.fixtures";

const AUTHORING_STAGES = ["requirements", "design"] as const;

function snapshotFor(
  revision: SpecRevision,
  elements: SpecRevisionSnapshot["elements"],
): SpecRevisionSnapshot {
  return { revision, elements, assumptionCitations: [] };
}

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
  stage: (typeof AUTHORING_STAGES)[number],
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
        : snapshotFor(currentApprovedRevision, elements),
    currentRevision: snapshotFor(currentRevision, elements),
    currentApprovedRevision:
      currentApprovedRevision === null
        ? null
        : snapshotFor(currentApprovedRevision, elements),
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

function approvedDesignDetail(): SpecDetailView {
  const base = specControlsDetailFixture();
  const template = base.revisions[0];
  const elements = base.currentRevision?.elements;
  if (template === undefined || elements === undefined) {
    throw new Error("Phase stepper story fixture is missing its snapshot");
  }
  const approved = revisionFor(template, 1, "design", "approved");
  return parsedDetail({
    ...base,
    revisions: [approved],
    baseRevision: null,
    currentRevision: snapshotFor(approved, elements),
    currentApprovedRevision: snapshotFor(approved, elements),
    executionRevisionSnapshots: [],
    status: { ...base.status, phase: { primary: "approved" } },
  });
}

function approvedPlanReview(): DeliveryPlanReviewView {
  return reviewView({
    attempt: { status: "approved" },
    approval: {
      snapshotId: "snapshot-2",
      candidateId: "candidate-2",
      candidateHash: "sha256:candidate-2",
      approvedAt: SPEC_CONTROLS_FIXTURE_NOW,
      approvedBy: { kind: "human" },
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
          status: { status: "completed" },
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
      delivery: {
        allWaived: false,
        deliveredCount: 1,
        provenCount: 1,
        deliveredExternallyCriterionIds: [],
        totalInScope: 1,
      },
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
    currentRevision: snapshotFor(amendment, elements),
    status: {
      ...detail.status,
      phase: { primary: "executing", authoringFacet: "in_review" },
    },
  });
}

const lifecycleVariants = [
  { name: "Initialized", detail: initializedDetail(), deliveryPlan: null },
  {
    name: "Requirements draft",
    detail: authoringDetail("requirements", "draft"),
    deliveryPlan: null,
  },
  {
    name: "Requirements review",
    detail: authoringDetail("requirements", "proposed"),
    deliveryPlan: null,
  },
  {
    name: "Design draft",
    detail: authoringDetail("design", "draft"),
    deliveryPlan: null,
  },
  {
    name: "Design review",
    detail: authoringDetail("design", "proposed"),
    deliveryPlan: null,
  },
  {
    name: "Delivery plan draft",
    detail: approvedDesignDetail(),
    deliveryPlan: reviewView({ attempt: { status: "draft" } }),
  },
  {
    name: "Delivery plan review",
    detail: approvedDesignDetail(),
    deliveryPlan: reviewView({ attempt: { status: "proposed" } }),
  },
  {
    name: "Ready",
    detail: approvedDesignDetail(),
    deliveryPlan: approvedPlanReview(),
  },
  {
    name: "Definition review",
    detail: parsedDetail(specControlsDetailFixture("definition_review")),
  },
  { name: "Running", detail: runningDetail() },
  { name: "Ready to merge", detail: awaitingMergeDetail() },
  { name: "Concurrent design review", detail: concurrentAuthoringDetail() },
  { name: "Delivered", detail: deliveredDetail() },
  { name: "Abandoned", detail: abandonedDetail() },
] satisfies ReadonlyArray<{
  name: string;
  detail: SpecDetailView;
  deliveryPlan?: DeliveryPlanReviewView | null;
}>;

const meta = {
  title: "Specs/Studio/Phase Stepper",
  component: SpecPhaseStepper,
  parameters: { a11y: { test: "error" }, layout: "fullscreen" },
  args: {
    detail: approvedDesignDetail(),
    deliveryPlan: approvedPlanReview(),
  },
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
            <SpecPhaseStepper
              detail={variant.detail}
              deliveryPlan={variant.deliveryPlan}
            />
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
