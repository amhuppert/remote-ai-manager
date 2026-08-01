import type { SpecDetailView } from "@/lib/specs/queries";
import type { SpecAuthoringStage, SpecRevision } from "@/lib/specs/schemas";
import { cn } from "@/lib/ui/cn";

const AUTHORING_STAGES = ["requirements", "design", "plan"] as const;

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
  label: "Requirements" | "Design" | "Plan" | "Execute" | "Deliver";
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
  return AUTHORING_STAGES.indexOf(stage);
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
  const { allWaived, provenCount, totalInScope } = detail.status.delivery;
  if (totalInScope === 0) return "awaiting execution scope";
  if (allWaived) {
    return `${totalInScope} ${
      totalInScope === 1 ? "criterion" : "criteria"
    } waived`;
  }
  return `${provenCount}/${totalInScope} ${
    totalInScope === 1 ? "criterion" : "criteria"
  } proven`;
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

function executionSublabel(detail: SpecDetailView): string {
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
  const taskCount = planTaskCount(detail);
  const workflowLabel =
    workflowStatus === "completed"
      ? "workflow complete"
      : workflowStatus.replaceAll("_", " ");
  if (taskCount === 0) return `${workflowLabel} · ${revision}`;

  const completed = completedTaskCount(detail);
  return `${workflowLabel} · ${completed}/${taskCount} ${
    taskCount === 1 ? "task" : "tasks"
  } done`;
}

function authoringStep(
  detail: SpecDetailView,
  revisions: readonly SpecRevision[],
  openRevision: SpecRevision | undefined,
  stage: SpecAuthoringStage,
): PhaseStep {
  const label =
    stage === "requirements"
      ? "Requirements"
      : stage === "design"
        ? "Design"
        : "Plan";
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
    const taskCount = stage === "plan" ? planTaskCount(detail) : 0;
    const taskSuffix =
      stage === "plan" && taskCount > 0
        ? ` · ${pluralizedCount(taskCount, "task")}`
        : "";
    return {
      label,
      state: "done",
      sublabel: `approved rev ${approvedRevision.number}${taskSuffix}`,
    };
  }

  return {
    label,
    state: "next",
    sublabel:
      stage === "requirements"
        ? "agent drafts first"
        : stage === "design"
          ? "starts after requirements"
          : "starts after design",
  };
}

function abandonedStepIndex(
  detail: SpecDetailView,
  revisions: readonly SpecRevision[],
  openRevision: SpecRevision | undefined,
): number {
  if (detail.executions.length > 0) return 3;
  if (openRevision !== undefined)
    return stageIndex(openRevision.authoringStage);

  const latestApproved = latestRevision(
    revisions,
    ({ state }) => state === "approved",
  );
  if (latestApproved === undefined) return 0;
  return Math.min(stageIndex(latestApproved.authoringStage) + 1, 3);
}

function executionRevisionNumber(detail: SpecDetailView): number | null {
  const execution = activeExecution(detail) ?? detail.executions.at(-1);
  return execution?.revisionNumber ?? null;
}

function contextSentence(
  detail: SpecDetailView,
  openRevision: SpecRevision | undefined,
  hasApprovedPlan: boolean,
): string {
  if (detail.status.phase.primary === "abandoned") {
    return `Abandoned: ${detail.spec.abandonedReason ?? "work stopped."}`;
  }

  const { provenCount, totalInScope } = detail.status.delivery;
  if (detail.status.phase.primary === "delivered") {
    if (detail.status.delivery.allWaived) {
      return `Delivered: all ${totalInScope} in-scope ${
        totalInScope === 1 ? "criterion" : "criteria"
      } waived. The spec is read-only history.`;
    }
    return `Delivered: ${provenCount}/${totalInScope} in-scope ${
      totalInScope === 1 ? "criterion" : "criteria"
    } proven. The spec is read-only history.`;
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
                : "Plan"
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
    const label =
      openRevision.authoringStage === "requirements"
        ? "Requirements"
        : openRevision.authoringStage === "design"
          ? "Design"
          : "Plan";
    if (openRevision.state === "proposed") {
      return `${label} rev ${openRevision.number} awaits review. The next lifecycle stage stays locked until sign-off.`;
    }
    return `${label} rev ${openRevision.number} is being drafted. The agent will propose it for review next.`;
  }

  if (detail.revisions.length === 0) {
    return "Spec initialized. The agent drafts the requirements contract first — design and plan stay locked until it is approved.";
  }

  if (hasApprovedPlan) {
    const planRevision = stageApprovalRevision(detail.revisions, "plan");
    return `All authoring stages are approved. Start execution against revision ${planRevision?.number ?? "unknown"} after selecting scope.`;
  }

  const latestApproved = latestRevision(
    detail.revisions,
    ({ state }) => state === "approved",
  );
  const nextStage =
    latestApproved?.authoringStage === "requirements" ? "Design" : "Plan";
  return `${nextStage} is next. The agent can begin drafting after the approved revision is recorded.`;
}

function projectStepper(detail: SpecDetailView): StepperProjection {
  const revisions = [...detail.revisions].sort(
    (left, right) => left.number - right.number,
  );
  const openRevision = latestRevision(
    revisions,
    ({ state }) => state === "draft" || state === "proposed",
  );
  const hasApprovedPlan = revisions.some(
    ({ state, authoringStage }) =>
      state === "approved" && authoringStage === "plan",
  );
  const authoringSteps = AUTHORING_STAGES.map((stage) =>
    authoringStep(detail, revisions, openRevision, stage),
  );
  const execution = activeExecution(detail);
  const executionWorkflowCompleted = workflowCompleted(detail, execution);

  let executeStep: PhaseStep = {
    label: "Execute",
    state: hasApprovedPlan ? "ready" : "locked",
    sublabel: hasApprovedPlan
      ? "ready — scope selection"
      : "locked until plan approved",
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
      sublabel: executionSublabel(detail),
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
      sublabel: "run complete",
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
    currentStep = abandonedStepIndex(detail, revisions, openRevision);
  } else if (execution !== undefined) {
    currentStep = executionWorkflowCompleted ? 4 : 3;
  } else if (openRevision !== undefined) {
    currentStep = stageIndex(openRevision.authoringStage);
  } else if (hasApprovedPlan) {
    currentStep = 3;
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
        : stageIndex(latestApproved.authoringStage) + 1,
      2,
    );
  }

  const steps = [...authoringSteps, executeStep, deliverStep];
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
    context: contextSentence(detail, openRevision, hasApprovedPlan),
    steps,
  };
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
}: {
  detail: SpecDetailView;
}): React.JSX.Element {
  const projection = projectStepper(detail);

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
