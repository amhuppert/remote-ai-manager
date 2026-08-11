import type { SpecDetailView } from "@/lib/specs/queries";
import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";
import type { SpecAuthoringStage, SpecRevision } from "@/lib/specs/schemas";
import type { LiveProposalView } from "@/lib/specs/view-schemas";
import { cn } from "@/lib/ui/cn";

import { strandedProposals } from "./live-proposals";
import { revisionAdmittedByImport } from "./presentation";

const ACTIVE_AUTHORING_STAGES = ["requirements", "design"] as const;
const DURABLE_AUTHORING_STAGES = ["requirements", "design", "plan"] as const;
type ActiveAuthoringStage = (typeof ACTIVE_AUTHORING_STAGES)[number];

type PhaseStepState =
  | "done"
  | "draft"
  | "review"
  | "ready"
  | "definition_review"
  | "running"
  | "next"
  | "locked"
  | "abandoned";

type PhaseStep = {
  label: "Requirements" | "Design" | "Delivery plan" | "Execute" | "Deliver";
  state: PhaseStepState;
  sublabel: string;
};

type StepperProjection = {
  currentStep: number;
  context: string;
  steps: readonly PhaseStep[];
};

const outerStateClass: Record<PhaseStepState, string> = {
  done: "bg-green-dim",
  draft: "bg-amber-dim",
  review: "bg-amber-dim",
  ready: "bg-cyan-dim",
  definition_review: "bg-cyan-dim",
  running: "bg-cyan-dim",
  next: "bg-border-subtle",
  locked: "bg-border-subtle",
  abandoned: "bg-red-dim",
};

const innerStateClass: Record<PhaseStepState, string> = {
  done: "[background:linear-gradient(var(--color-green-glow),var(--color-green-glow)),var(--color-bg-base)]",
  draft:
    "[background:linear-gradient(var(--color-amber-glow),var(--color-amber-glow)),var(--color-bg-base)]",
  review:
    "[background:linear-gradient(var(--color-amber-glow),var(--color-amber-glow)),var(--color-bg-base)]",
  ready:
    "[background:linear-gradient(var(--color-cyan-glow),var(--color-cyan-glow)),var(--color-bg-base)]",
  definition_review:
    "[background:linear-gradient(var(--color-cyan-glow),var(--color-cyan-glow)),var(--color-bg-base)]",
  running:
    "[background:linear-gradient(var(--color-cyan-glow),var(--color-cyan-glow)),var(--color-bg-base)]",
  next: "bg-bg-surface",
  locked: "bg-bg-base",
  abandoned:
    "[background:linear-gradient(var(--color-red-glow),var(--color-red-glow)),var(--color-bg-base)]",
};

const labelStateClass: Record<PhaseStepState, string> = {
  done: "text-green",
  draft: "text-amber",
  review: "text-amber",
  ready: "text-cyan",
  definition_review: "text-cyan",
  running: "text-cyan",
  next: "text-text-tertiary",
  locked: "text-text-tertiary",
  abandoned: "text-red",
};

const shapeClass = {
  first:
    "[clip-path:polygon(0_0,calc(100%_-_var(--spacing-md))_0,100%_50%,calc(100%_-_var(--spacing-md))_100%,0_100%)]",
  middle:
    "[clip-path:polygon(0_0,calc(100%_-_var(--spacing-md))_0,100%_50%,calc(100%_-_var(--spacing-md))_100%,0_100%,var(--spacing-md)_50%)]",
  last: "[clip-path:polygon(0_0,100%_0,100%_100%,0_100%,var(--spacing-md)_50%)]",
} as const;

const contentPaddingClass = {
  first: "pr-lg pl-md",
  middle: "pr-lg pl-xl",
  last: "pr-md pl-xl",
} as const;

function stageIndex(stage: SpecAuthoringStage): number {
  return DURABLE_AUTHORING_STAGES.indexOf(stage);
}

function lifecycleIndex(stage: SpecAuthoringStage): number {
  if (stage === "requirements") return 0;
  if (stage === "design") return 1;
  return 2;
}

function latestRevision(
  revisions: readonly SpecRevision[],
  predicate: (revision: SpecRevision) => boolean,
): SpecRevision | undefined {
  return revisions.toReversed().find(predicate);
}

function stageApprovalRevision(
  revisions: readonly SpecRevision[],
  stage: SpecAuthoringStage,
): SpecRevision | undefined {
  const exactRevision = latestRevision(
    revisions,
    (revision) =>
      revision.state === "approved" && revision.authoringStage === stage,
  );
  if (exactRevision !== undefined) return exactRevision;

  return revisions.find(
    (revision) =>
      revision.state === "approved" &&
      stageIndex(revision.authoringStage) > stageIndex(stage),
  );
}

function planTaskCount(detail: SpecDetailView): number {
  if (detail.status.taskPlan.length > 0) return detail.status.taskPlan.length;

  const planSnapshot =
    detail.currentRevision?.revision.authoringStage === "plan"
      ? detail.currentRevision
      : detail.currentApprovedRevision;
  return (
    planSnapshot?.elements.filter(
      ({ version }) => version.payload.kind === "task",
    ).length ?? 0
  );
}

function pluralizedCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function completedTaskCount(detail: SpecDetailView): number {
  return detail.elementStatuses.tasks.filter(
    ({ status }) => status.status === "completed",
  ).length;
}

function proofSublabel(detail: SpecDetailView): string {
  const {
    allWaived,
    provenCount,
    totalInScope,
    deliveredExternallyCriterionIds,
  } = detail.status.delivery;
  if (totalInScope === 0) return "awaiting execution scope";
  const noun = totalInScope === 1 ? "criterion" : "criteria";
  if (allWaived) return `${totalInScope} ${noun} waived`;

  // External delivery is reported beside the proof tally, never inside it: an
  // import that proved nothing here would otherwise be described only by what
  // it lacks.
  const externalCount = deliveredExternallyCriterionIds.length;
  if (externalCount === 0)
    return `${provenCount}/${totalInScope} ${noun} proven`;
  if (provenCount === 0) {
    return `${externalCount}/${totalInScope} ${noun} delivered externally`;
  }
  return `${provenCount}/${totalInScope} ${noun} proven · ${externalCount} delivered externally`;
}

function activeExecution(detail: SpecDetailView) {
  return detail.executions
    .toReversed()
    .find(({ state }) => state === "definition_review" || state === "running");
}

function workflowCompleted(
  detail: SpecDetailView,
  execution: ReturnType<typeof activeExecution>,
): boolean {
  if (execution?.state !== "running") return false;
  return detail.status.executions.some(
    (statusExecution) =>
      statusExecution.id === execution.id &&
      statusExecution.workflowStatus === "completed",
  );
}

function executionSublabel(
  detail: SpecDetailView,
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
): string {
  const execution = activeExecution(detail);
  if (execution === undefined) return "ready — scope selection";

  const revision =
    execution.revisionNumber === null
      ? "pinned revision"
      : `rev ${execution.revisionNumber}`;
  if (execution.state === "definition_review") {
    return `definition review · ${revision}`;
  }

  const statusExecution = detail.status.executions.find(
    ({ id }) => id === execution.id,
  );
  const workflowStatus = statusExecution?.workflowStatus ?? "running";
  const taskCount =
    deliveryPlan === null || deliveryPlan === undefined
      ? planTaskCount(detail)
      : deliveryPlan.attempt.launchedExecutionId === execution.id
        ? deliveryPlan.document.tasks.length
        : null;
  const workflowLabel =
    workflowStatus === "completed"
      ? "workflow complete"
      : workflowStatus.replaceAll("_", " ");
  if (taskCount === null || taskCount === 0) {
    return `${workflowLabel} · ${revision}`;
  }

  const completed = completedTaskCount(detail);
  return `${workflowLabel} · ${completed}/${taskCount} ${
    taskCount === 1 ? "task" : "tasks"
  } done`;
}

function authoringStep(
  detail: SpecDetailView,
  revisions: readonly SpecRevision[],
  openRevision: SpecRevision | undefined,
  stage: ActiveAuthoringStage,
): PhaseStep {
  const label = stage === "requirements" ? "Requirements" : "Design";
  if (openRevision?.authoringStage === stage) {
    return {
      label,
      state: openRevision.state === "proposed" ? "review" : "draft",
      sublabel:
        openRevision.state === "proposed"
          ? `rev ${openRevision.number} in review`
          : `rev ${openRevision.number} drafting`,
    };
  }

  if (
    revisions.length === 0 &&
    stage === "requirements" &&
    detail.status.phase.primary === "draft"
  ) {
    return { label, state: "draft", sublabel: "agent drafting" };
  }

  const approvedRevision = stageApprovalRevision(revisions, stage);
  if (approvedRevision !== undefined) {
    return {
      label,
      state: "done",
      // An imported revision reaches this state on the source's word with no
      // approval row behind it, so the stage names the admission rather than
      // borrowing the vocabulary of a human sign-off. The question is asked of
      // the revision this stage names, never of the spec: a later amendment
      // approved by a human keeps the credit for the act it took.
      sublabel: revisionAdmittedByImport(
        detail.gateAdmissions,
        approvedRevision.id,
      )
        ? `rev ${approvedRevision.number} admitted by import`
        : `approved rev ${approvedRevision.number}`,
    };
  }

  return {
    label,
    state: "next",
    sublabel:
      stage === "requirements"
        ? "agent drafts first"
        : "starts after requirements",
  };
}

function deliveryPlanTaskSublabel(
  deliveryPlan: DeliveryPlanReviewView,
  state: string,
): string {
  const count = deliveryPlan.document.tasks.length;
  return `${pluralizedCount(count, "task")} · ${state}`;
}

function deliveryPlanIsApproved(
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
): boolean {
  if (
    deliveryPlan === null ||
    deliveryPlan === undefined ||
    deliveryPlan.approval === null
  ) {
    return false;
  }
  return (
    deliveryPlan.attempt.status === "approved" ||
    deliveryPlan.attempt.status === "parked" ||
    deliveryPlan.attempt.status === "launched"
  );
}

function deliveryPlanStep(
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
  designApproved: boolean,
  execution: ReturnType<typeof activeExecution>,
): PhaseStep {
  if (
    execution !== undefined &&
    (deliveryPlan === null ||
      deliveryPlan === undefined ||
      deliveryPlan.attempt.launchedExecutionId === execution.id)
  ) {
    return {
      label: "Delivery plan",
      state: "done",
      sublabel:
        deliveryPlan === null || deliveryPlan === undefined
          ? "legacy plan launched"
          : deliveryPlanTaskSublabel(deliveryPlan, "candidate launched"),
    };
  }

  if (deliveryPlan === undefined) {
    return {
      label: "Delivery plan",
      state: designApproved ? "next" : "locked",
      sublabel: designApproved ? "checking attempt" : "starts after design",
    };
  }

  if (deliveryPlan === null) {
    return {
      label: "Delivery plan",
      state: designApproved ? "next" : "locked",
      sublabel: designApproved ? "open an attempt" : "starts after design",
    };
  }

  switch (deliveryPlan.attempt.status) {
    case "draft":
      return {
        label: "Delivery plan",
        state: "draft",
        sublabel: deliveryPlanTaskSublabel(deliveryPlan, "drafting"),
      };
    case "proposed":
      return {
        label: "Delivery plan",
        state: "review",
        sublabel: deliveryPlanTaskSublabel(deliveryPlan, "candidate in review"),
      };
    case "approved":
      return {
        label: "Delivery plan",
        state: "done",
        sublabel: `candidate approved · ${pluralizedCount(
          deliveryPlan.document.tasks.length,
          "task",
        )}`,
      };
    case "parked":
      return {
        label: "Delivery plan",
        state: deliveryPlan.approval === null ? "review" : "ready",
        sublabel: deliveryPlanTaskSublabel(
          deliveryPlan,
          deliveryPlan.approval === null
            ? "parked · approval required"
            : "parked · candidate approved",
        ),
      };
    case "launched":
      return {
        label: "Delivery plan",
        state: "done",
        sublabel: deliveryPlanTaskSublabel(deliveryPlan, "candidate launched"),
      };
    case "abandoned":
      return {
        label: "Delivery plan",
        state: "abandoned",
        sublabel: "attempt abandoned",
      };
  }
}

function abandonedStepIndex(
  detail: SpecDetailView,
  revisions: readonly SpecRevision[],
  openRevision: SpecRevision | undefined,
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
): number {
  if (detail.executions.length > 0) return 3;
  if (deliveryPlan !== null && deliveryPlan !== undefined) return 2;
  if (openRevision !== undefined) {
    return lifecycleIndex(openRevision.authoringStage);
  }

  const latestApproved = latestRevision(
    revisions,
    ({ state }) => state === "approved",
  );
  if (latestApproved === undefined) return 0;
  return Math.min(lifecycleIndex(latestApproved.authoringStage) + 1, 2);
}

function executionRevisionNumber(detail: SpecDetailView): number | null {
  const execution = activeExecution(detail) ?? detail.executions.at(-1);
  return execution?.revisionNumber ?? null;
}

function contextSentence(
  detail: SpecDetailView,
  openRevision: SpecRevision | undefined,
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
): string {
  if (detail.status.phase.primary === "abandoned") {
    return `Abandoned: ${detail.spec.abandonedReason ?? "work stopped."}`;
  }

  const { provenCount, totalInScope, deliveredExternallyCriterionIds } =
    detail.status.delivery;
  if (detail.status.phase.primary === "delivered") {
    const noun = totalInScope === 1 ? "criterion" : "criteria";
    if (detail.status.delivery.allWaived) {
      return `Delivered: all ${totalInScope} in-scope ${noun} waived. The spec is read-only history.`;
    }
    const externalCount = deliveredExternallyCriterionIds.length;
    if (externalCount > 0) {
      return provenCount === 0
        ? `Delivered: ${externalCount}/${totalInScope} in-scope ${noun} delivered externally, none proven here. The spec is read-only history.`
        : `Delivered: ${provenCount}/${totalInScope} in-scope ${noun} proven, ${externalCount} delivered externally. The spec is read-only history.`;
    }
    return `Delivered: ${provenCount}/${totalInScope} in-scope ${noun} proven. The spec is read-only history.`;
  }

  const execution = activeExecution(detail);
  if (execution !== undefined) {
    const revision = executionRevisionNumber(detail);
    const revisionLabel =
      revision === null ? "its pinned revision" : `pinned revision ${revision}`;
    const concurrentAuthoring =
      openRevision === undefined
        ? ""
        : ` ${
            openRevision.authoringStage === "requirements"
              ? "Requirements"
              : openRevision.authoringStage === "design"
                ? "Design"
                : "Legacy Plan"
          } rev ${openRevision.number} also ${
            openRevision.state === "proposed"
              ? "awaits review"
              : "is being drafted"
          }.`;
    if (execution.state === "definition_review") {
      return `Execution definition for revision ${revision ?? "unknown"} awaits review before the workflow can start.${concurrentAuthoring}`;
    }
    if (workflowCompleted(detail, execution)) {
      const session =
        execution.sessionName === null
          ? "the execution session"
          : `session ${execution.sessionName}`;
      return `Workflow complete for ${revisionLabel}. Merge ${session} to its delivery target to record delivery for ${totalInScope} in-scope ${
        totalInScope === 1 ? "criterion" : "criteria"
      }.${concurrentAuthoring}`;
    }
    return `Execution is running against ${revisionLabel}. Delivery proof accumulates per acceptance criterion.${concurrentAuthoring}`;
  }

  if (openRevision !== undefined) {
    if (openRevision.authoringStage === "plan") {
      return `Legacy Plan rev ${openRevision.number} remains readable. Delivery changes belong in a delivery plan attempt.`;
    }
    const label =
      openRevision.authoringStage === "requirements"
        ? "Requirements"
        : "Design";
    if (openRevision.state === "proposed") {
      return `${label} rev ${openRevision.number} awaits review. The next lifecycle stage stays locked until sign-off.`;
    }
    return `${label} rev ${openRevision.number} is being drafted. The agent will propose it for review next.`;
  }

  if (detail.revisions.length === 0) {
    return "Spec initialized. The agent drafts the requirements contract first — design and delivery planning stay locked until it is approved.";
  }

  const latestApproved = latestRevision(
    detail.revisions,
    ({ state }) => state === "approved",
  );
  if (deliveryPlan === undefined) {
    if (latestApproved?.authoringStage === "requirements") {
      return "Design is next. The agent can begin drafting after the approved revision is recorded.";
    }
    return "Evergreen design is approved. Checking for a delivery plan attempt.";
  }

  if (deliveryPlan !== null) {
    const attemptId = deliveryPlan.attempt.id;
    switch (deliveryPlan.attempt.status) {
      case "draft":
        return `Delivery plan attempt ${attemptId} is being drafted. Propose its authored graph for review next.`;
      case "proposed":
        return `Delivery plan attempt ${attemptId} awaits review of its exact compiled candidate.`;
      case "approved":
        return deliveryPlan.approval === null
          ? `Delivery plan attempt ${attemptId} still needs candidate-bound approval.`
          : "Delivery plan candidate is approved. Launch that exact candidate when execution should begin.";
      case "parked":
        return deliveryPlan.approval === null
          ? `Delivery plan attempt ${attemptId} is parked and needs candidate-bound approval before launch.`
          : "Delivery plan candidate is approved and parked. Launch that exact candidate when execution should begin.";
      case "launched":
        return `Delivery plan attempt ${attemptId} has launched its approved candidate.`;
      case "abandoned":
        return `Delivery plan attempt ${attemptId} was abandoned. Open a replacement attempt to continue delivery planning.`;
    }
  }

  if (latestApproved?.authoringStage === "requirements") {
    return "Design is next. The agent can begin drafting after the approved revision is recorded.";
  }
  return "Delivery planning is next. Open a delivery plan attempt against the approved evergreen revision.";
}

function projectStepper(
  detail: SpecDetailView,
  deliveryPlan: DeliveryPlanReviewView | null | undefined,
): StepperProjection {
  const revisions = [...detail.revisions].sort(
    (left, right) => left.number - right.number,
  );
  // A proposal an approved revision forked past is not the spec's open
  // authoring line: it cannot be signed off and it locks no stage. Describing
  // it as the open revision is what made the strip promise a sign-off that
  // could never happen (#50), so it is named separately instead.
  const stranded = strandedProposals(detail);
  const strandedIds = new Set(stranded.map((entry) => entry.revision.id));
  const openRevision = latestRevision(
    revisions,
    (revision) =>
      (revision.state === "draft" || revision.state === "proposed") &&
      !strandedIds.has(revision.id),
  );
  const designApproved =
    stageApprovalRevision(revisions, "design") !== undefined;
  const authoringSteps = ACTIVE_AUTHORING_STAGES.map((stage) =>
    authoringStep(detail, revisions, openRevision, stage),
  );
  const execution = activeExecution(detail);
  const executionWorkflowCompleted = workflowCompleted(detail, execution);
  const planStep = deliveryPlanStep(deliveryPlan, designApproved, execution);
  const approvedCandidate = deliveryPlanIsApproved(deliveryPlan);

  let executeStep: PhaseStep = {
    label: "Execute",
    state: approvedCandidate ? "ready" : "locked",
    sublabel: approvedCandidate
      ? "ready — launch candidate"
      : "locked until delivery plan approved",
  };
  let deliverStep: PhaseStep = {
    label: "Deliver",
    state: "locked",
    sublabel:
      execution === undefined || detail.status.delivery.provenCount === 0
        ? "proof against pinned revision"
        : proofSublabel(detail),
  };

  if (execution !== undefined) {
    executeStep = {
      label: "Execute",
      state:
        execution.state === "definition_review"
          ? "definition_review"
          : executionWorkflowCompleted
            ? "done"
            : "running",
      sublabel: executionSublabel(detail, deliveryPlan),
    };
    if (executionWorkflowCompleted) {
      deliverStep = {
        label: "Deliver",
        state: "ready",
        sublabel: "ready — merge session",
      };
    }
  }

  if (detail.status.phase.primary === "delivered") {
    executeStep = {
      label: "Execute",
      state: "done",
      // An imported spec is delivered on the source's testimony without ever
      // running here, so the step reports the absence of a run rather than
      // borrowing the label of one that never happened.
      sublabel: detail.executions.length === 0 ? "no run here" : "run complete",
    };
    deliverStep = {
      label: "Deliver",
      state: "done",
      sublabel: proofSublabel(detail),
    };
  }

  let currentStep: number;
  if (detail.status.phase.primary === "delivered") {
    currentStep = 4;
  } else if (detail.status.phase.primary === "abandoned") {
    currentStep = abandonedStepIndex(
      detail,
      revisions,
      openRevision,
      deliveryPlan,
    );
  } else if (execution !== undefined) {
    currentStep = executionWorkflowCompleted ? 4 : 3;
  } else if (openRevision !== undefined) {
    currentStep = lifecycleIndex(openRevision.authoringStage);
  } else if (approvedCandidate) {
    currentStep = 3;
  } else if (deliveryPlan !== null && deliveryPlan !== undefined) {
    currentStep = 2;
  } else if (revisions.length === 0) {
    currentStep = 0;
  } else {
    const latestApproved = latestRevision(
      revisions,
      ({ state }) => state === "approved",
    );
    currentStep = Math.min(
      latestApproved === undefined
        ? 0
        : lifecycleIndex(latestApproved.authoringStage) + 1,
      2,
    );
  }

  const steps = [...authoringSteps, planStep, executeStep, deliverStep];
  if (detail.status.phase.primary === "abandoned") {
    const interrupted = steps[currentStep];
    if (interrupted !== undefined) {
      steps[currentStep] = {
        ...interrupted,
        state: "abandoned",
        sublabel: "abandoned",
      };
    }
  }

  return {
    currentStep,
    context:
      contextSentence(detail, openRevision, deliveryPlan) +
      strandedSentence(detail, stranded),
    steps,
  };
}

/**
 * The clause that names a stranded proposal and its only exit. It rides after
 * whatever the lifecycle sentence says rather than replacing it: the spec's
 * live line and the reviewed work left behind are both true at once, and #50's
 * strip reported only the first.
 */
function strandedSentence(
  detail: SpecDetailView,
  stranded: readonly LiveProposalView[],
): string {
  const newest = stranded.at(-1);
  if (newest === undefined) return "";
  if (detail.status.phase.primary === "abandoned") return "";
  const others =
    stranded.length > 1
      ? ` ${stranded.length - 1} older ${stranded.length === 2 ? "proposal is" : "proposals are"} stranded the same way.`
      : "";
  return ` Revision ${newest.revision.number} is stranded: revision ${newest.supersededBy?.number} was approved past it, so it can no longer be signed off — dismiss it from Review.${others}`;
}

function StepIcon({ state }: { state: PhaseStepState }): React.JSX.Element {
  const commonProps = {
    "aria-hidden": true,
    className: cn(
      "size-lg shrink-0",
      (state === "review" || state === "running") &&
        "animate-pulse-dot motion-reduce:animate-none",
    ),
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "square" as const,
    strokeLinejoin: "miter" as const,
    strokeWidth: 1.5,
    viewBox: "0 0 16 16",
  };

  if (state === "done") {
    return (
      <svg {...commonProps}>
        <path d="m3 8 3 3 7-7" />
      </svg>
    );
  }
  if (state === "draft") {
    return (
      <svg {...commonProps}>
        <path d="m3 11-.5 2.5L5 13l7.25-7.25-2-2L3 11Z" />
        <path d="m9.25 4.75 2 2" />
      </svg>
    );
  }
  if (state === "ready") {
    return (
      <svg {...commonProps}>
        <path d="m5 3 7 5-7 5V3Z" />
      </svg>
    );
  }
  if (state === "definition_review") {
    return (
      <svg {...commonProps}>
        <path d="M3 2.5h7l3 3v8H3v-11Z" />
        <path d="M10 2.5v3h3M5.5 8h5M5.5 10.5h3" />
      </svg>
    );
  }
  if (state === "abandoned") {
    return (
      <svg {...commonProps}>
        <path d="m4 4 8 8M12 4l-8 8" />
      </svg>
    );
  }

  return (
    <svg {...commonProps}>
      <circle cx="8" cy="8" r="4.5" />
    </svg>
  );
}

function stepShape(index: number): keyof typeof shapeClass {
  if (index === 0) return "first";
  if (index === 4) return "last";
  return "middle";
}

export default function SpecPhaseStepper({
  detail,
  deliveryPlan,
}: {
  detail: SpecDetailView;
  deliveryPlan?: DeliveryPlanReviewView | null;
}): React.JSX.Element {
  const projection = projectStepper(detail, deliveryPlan);

  return (
    <section
      className="border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base px-xl py-md max-768:px-md"
      data-testid="spec-phase-stepper"
    >
      <div
        role="region"
        aria-label="Spec lifecycle progress"
        className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan"
        tabIndex={0}
      >
        <ol
          aria-label="Spec lifecycle"
          className="m-0 flex min-w-[calc(var(--spacing-3xl)*15)] list-none items-stretch p-0"
          role="list"
        >
          {projection.steps.map((step, index) => {
            const shape = stepShape(index);
            const isCurrent = index === projection.currentStep;
            return (
              <li
                key={step.label}
                aria-current={isCurrent ? "step" : undefined}
                aria-label={`${step.label}: ${step.sublabel}`}
                className="-ml-md min-w-0 flex-1 first:ml-0"
                data-state={step.state}
              >
                <div
                  className={cn(
                    "h-full p-px",
                    shapeClass[shape],
                    outerStateClass[step.state],
                  )}
                >
                  <div
                    className={cn(
                      "flex h-full min-h-[calc(var(--spacing-3xl)+var(--spacing-sm))] flex-col justify-center py-sm",
                      shapeClass[shape],
                      contentPaddingClass[shape],
                      innerStateClass[step.state],
                    )}
                  >
                    <span
                      className={cn(
                        "flex items-center gap-xs font-mono text-[0.72rem] font-bold tracking-[0.06em] uppercase",
                        labelStateClass[step.state],
                      )}
                    >
                      <StepIcon state={step.state} />
                      <span>{step.label}</span>
                    </span>
                    <span className="truncate pl-[calc(var(--spacing-lg)+var(--spacing-xs))] font-mono text-[0.64rem] text-text-tertiary">
                      {step.sublabel}
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <p className="mt-sm mb-0 font-mono text-[0.68rem] leading-relaxed text-text-tertiary">
        {projection.context}
      </p>
    </section>
  );
}
