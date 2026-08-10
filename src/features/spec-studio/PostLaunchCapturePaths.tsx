"use client";

import Link from "next/link";
import { useState } from "react";

import { TrashIcon } from "@/components/icons";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogActions,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/AlertDialog";
import { Button } from "@/components/ui/Button";
import {
  FormError,
  FormGroup,
  FormHint,
  FormInput,
  FormLabel,
} from "@/components/ui/FormField";
import { IconButton } from "@/components/ui/IconButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip } from "@/components/ui/StatusChip";
import { WithTooltip } from "@/components/ui/WithTooltip";
import type { TaskElementPayload } from "@/lib/specs/schemas";
import type { GraphWorkflowExecutionAmendedEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  WorkflowAmendmentOperation,
  WorkflowExecutionAmendmentRequest,
  WorkflowExecutionAmendmentResponse,
} from "@/lib/workflow-graph/execution-amendment";

export interface CaptureDiscoveredWorkRequest {
  executionId?: string;
  discoveredTask: Omit<TaskElementPayload, "kind">;
  blockingReason?: string;
}

export interface CaptureScopeAmendmentReceipt {
  discovery: {
    id: string;
    executionId: string;
    attemptId: string | null;
    title: string;
  };
  restartRequired: boolean;
  replacement: {
    abandonedExecutionId: string;
    replacementAttemptId: string;
  } | null;
}

export type WorkflowAmendmentReceipt = WorkflowExecutionAmendmentResponse;

export interface PostLaunchFailure {
  message: string;
  instruction: string | null;
}

export interface PostLaunchCapturePathsProps {
  projectName: string;
  slug: string;
  executionId: string | null;
  state: "running" | "unlaunched";
  canRequestAmendment: boolean;
  capturePending: boolean;
  captureOutcomePath: "discovery" | "replan" | null;
  captureReceipt: CaptureScopeAmendmentReceipt | null;
  captureFailure: PostLaunchFailure | null;
  amendmentPending: boolean;
  amendmentReceipt: WorkflowAmendmentReceipt | null;
  amendmentEvent: GraphWorkflowExecutionAmendedEvent | null;
  amendmentFailure: PostLaunchFailure | null;
  onCapture(
    path: "discovery" | "replan",
    request: CaptureDiscoveredWorkRequest,
  ): void;
  onAmend(request: WorkflowExecutionAmendmentRequest): void;
}

const taskSeed = {
  tracedRequirementElementIds: [],
  tracedDecisionElementIds: [],
  coveredCriterionElementIds: [],
  dependsOnTaskElementIds: [],
};

const cardClass =
  "flex min-w-0 flex-col rounded-lg border border-solid border-border-subtle bg-bg-surface p-md";

function requestForDiscovery(
  executionId: string | null,
  title: string,
  instructions: string,
  blockingReason?: string,
): CaptureDiscoveredWorkRequest {
  return {
    ...(executionId === null ? {} : { executionId }),
    discoveredTask: {
      title: title.trim(),
      instructions: instructions.trim(),
      ...taskSeed,
    },
    ...(blockingReason === undefined
      ? {}
      : { blockingReason: blockingReason.trim() }),
  };
}

function FailureNotice({ failure }: { failure: PostLaunchFailure }) {
  return (
    <div
      role="alert"
      className="mt-md rounded-md border border-solid border-[var(--cc-red-border)] bg-red-glow p-sm"
    >
      <FormError layoutClassName="mt-0">{failure.message}</FormError>
      {failure.instruction !== null && (
        <p className="mt-xs mb-0 font-mono text-[0.68rem] leading-relaxed [overflow-wrap:anywhere] text-text-primary">
          Remedy: {failure.instruction}
        </p>
      )}
    </div>
  );
}

function CardHeading({
  index,
  title,
  tone,
  children,
}: {
  index: string;
  title: string;
  tone: "cyan" | "amber";
  children: React.ReactNode;
}) {
  return (
    <header className="mb-md border-x-0 border-t-0 border-b border-solid border-border-dim pb-sm">
      <div className="flex flex-wrap items-center justify-between gap-xs">
        <h3 className="m-0 font-display text-[0.84rem] font-extrabold text-text-primary">
          {title}
        </h3>
        <StatusChip tone={tone}>{index}</StatusChip>
      </div>
      <p className="mt-xs mb-0 font-mono text-[0.68rem] leading-relaxed text-text-secondary">
        {children}
      </p>
    </header>
  );
}

function DiscoveryReceipt({
  receipt,
}: {
  receipt: CaptureScopeAmendmentReceipt;
}) {
  return (
    <div className="mt-md rounded-md border border-solid border-[var(--cc-green-border)] bg-green-glow p-sm">
      <p className="m-0 font-mono text-[0.68rem] font-bold text-green">
        Durable discovery recorded
      </p>
      <p className="mt-xs mb-0 font-mono text-[0.66rem] leading-relaxed [overflow-wrap:anywhere] text-text-primary">
        {receipt.discovery.id} · execution {receipt.discovery.executionId} ·
        attempt {receipt.discovery.attemptId ?? "legacy"} ·{" "}
        {receipt.discovery.title}
      </p>
    </div>
  );
}

function ReplanReceipt({ receipt }: { receipt: CaptureScopeAmendmentReceipt }) {
  const replacement = receipt.replacement;
  if (replacement === null) return null;
  return (
    <div className="mt-md rounded-md border border-solid border-[var(--cc-green-border)] bg-green-glow p-sm">
      <p className="m-0 font-mono text-[0.68rem] font-bold text-green">
        Seeded replacement opened
      </p>
      <p className="mt-xs mb-0 font-mono text-[0.66rem] leading-relaxed [overflow-wrap:anywhere] text-text-primary">
        abandoned {replacement.abandonedExecutionId} · new{" "}
        {replacement.replacementAttemptId}
        {" · "}discovery {receipt.discovery.id}
      </p>
    </div>
  );
}

function DiscoveryCard({
  executionId,
  state,
  planHref,
  pending,
  receipt,
  failure,
  onCapture,
}: {
  executionId: string | null;
  state: "running" | "unlaunched";
  planHref: string;
  pending: boolean;
  receipt: CaptureScopeAmendmentReceipt | null;
  failure: PostLaunchFailure | null;
  onCapture(request: CaptureDiscoveredWorkRequest): void;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const ready = title.trim().length > 0 && instructions.trim().length > 0;

  return (
    <section aria-label="Non-blocking discovery" className={cardClass}>
      <CardHeading index="01" title="Discovery" tone="cyan">
        Record work for the next seeded attempt. This run keeps its pinned
        scope.
      </CardHeading>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-discovery-title">Task title</FormLabel>
        <FormInput
          id="post-launch-discovery-title"
          aria-label="Discovery title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-discovery-instructions">
          Instructions
        </FormLabel>
        <FormInput
          id="post-launch-discovery-instructions"
          aria-label="Discovery instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      {state === "unlaunched" && (
        <FormHint layoutClassName="mt-0 mb-sm">
          No run is available for capture. The production route will name
          whether this attempt needs plan edit or reopen.
        </FormHint>
      )}
      <Button
        size="sm"
        variant="primary"
        touch
        layoutClassName="mt-auto self-start"
        loading={pending}
        disabled={!ready}
        onClick={() =>
          onCapture(requestForDiscovery(executionId, title, instructions))
        }
      >
        Record discovery
      </Button>
      {state === "unlaunched" && (
        <Link
          href={planHref}
          className="mt-sm self-start font-mono text-[0.68rem] font-semibold text-cyan no-underline hover:text-cyan-dim focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          Open delivery plan
        </Link>
      )}
      {receipt !== null && <DiscoveryReceipt receipt={receipt} />}
      {failure !== null && <FailureNotice failure={failure} />}
    </section>
  );
}

function ReplanCard({
  executionId,
  state,
  planHref,
  pending,
  receipt,
  failure,
  onCapture,
}: {
  executionId: string | null;
  state: "running" | "unlaunched";
  planHref: string;
  pending: boolean;
  receipt: CaptureScopeAmendmentReceipt | null;
  failure: PostLaunchFailure | null;
  onCapture(request: CaptureDiscoveredWorkRequest): void;
}) {
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [reason, setReason] = useState("");
  const ready =
    title.trim().length > 0 &&
    instructions.trim().length > 0 &&
    reason.trim().length > 0;
  const target = executionId ?? "the unlaunched attempt";

  function capture(): void {
    onCapture(requestForDiscovery(executionId, title, instructions, reason));
  }

  return (
    <section aria-label="Blocking replan" className={cardClass}>
      <CardHeading index="02" title="Blocking replan" tone="amber">
        Record the blocker, abandon this execution, and open a seeded
        replacement.
      </CardHeading>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-replan-title">Task title</FormLabel>
        <FormInput
          id="post-launch-replan-title"
          aria-label="Replan task title"
          value={title}
          onChange={(event) => setTitle(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-replan-instructions">
          Instructions
        </FormLabel>
        <FormInput
          id="post-launch-replan-instructions"
          aria-label="Replan task instructions"
          value={instructions}
          onChange={(event) => setInstructions(event.currentTarget.value)}
          autoComplete="off"
        />
      </FormGroup>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-replan-reason">
          Blocking reason
        </FormLabel>
        <FormInput
          id="post-launch-replan-reason"
          aria-label="Blocking reason"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          placeholder="Required durable reason"
          autoComplete="off"
        />
      </FormGroup>
      {state === "unlaunched" ? (
        <Link
          href={planHref}
          className="mt-auto self-start rounded-md border border-solid border-border-default bg-bg-surface px-[12px] py-[6px] font-mono text-[0.72rem] font-medium text-text-primary no-underline hover:border-border-strong hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2 max-768:min-h-[44px]"
        >
          Open delivery plan
        </Link>
      ) : (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="default"
              touch
              layoutClassName="mt-auto self-start"
              loading={pending}
              disabled={!ready}
            >
              Replan execution
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent size="default">
            <AlertDialogTitle>Abandon execution {target}?</AlertDialogTitle>
            <AlertDialogDescription>
              Execution {target} is abandoned before the captured discovery
              opens a seeded replacement attempt. The abandoned run remains
              durable history.
            </AlertDialogDescription>
            <AlertDialogActions>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction danger onClick={capture} loading={pending}>
                Abandon {target} and open seeded plan
              </AlertDialogAction>
            </AlertDialogActions>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {receipt !== null && <ReplanReceipt receipt={receipt} />}
      {failure !== null && <FailureNotice failure={failure} />}
    </section>
  );
}

type AdditionType = WorkflowAmendmentOperation["type"];

function operationLabel(operation: WorkflowAmendmentOperation): string {
  switch (operation.type) {
    case "add-context":
      return `context ${operation.id}`;
    case "add-task":
      return `task ${operation.id} → ${operation.contextId}`;
    case "add-edge":
      return `edge ${operation.id}: ${operation.sourceContextId} → ${operation.targetContextId}`;
  }
}

function QueuedOperations({
  operations,
  onRemove,
}: {
  operations: readonly WorkflowAmendmentOperation[];
  onRemove(index: number): void;
}) {
  if (operations.length === 0) {
    return (
      <p className="mt-sm mb-0 font-mono text-[0.66rem] text-text-tertiary">
        No additions queued.
      </p>
    );
  }
  return (
    <ol className="mt-sm mb-0 grid list-none gap-xs p-0">
      {operations.map((operation, index) => (
        <li
          key={`${operation.type}:${operation.id}:${index}`}
          className="flex min-w-0 items-center gap-xs rounded-md border border-solid border-border-dim bg-bg-base px-sm py-xs"
        >
          <span className="min-w-0 flex-1 font-mono text-[0.64rem] [overflow-wrap:anywhere] text-text-primary">
            {operationLabel(operation)}
          </span>
          <WithTooltip label="Remove addition">
            <IconButton
              variant="ghost"
              tone="danger"
              aria-label={`Remove ${operationLabel(operation)}`}
              onClick={() => onRemove(index)}
            >
              <TrashIcon size={14} />
            </IconButton>
          </WithTooltip>
        </li>
      ))}
    </ol>
  );
}

function AmendmentReceipt({
  receipt,
  event,
}: {
  receipt: WorkflowAmendmentReceipt | null;
  event: GraphWorkflowExecutionAmendedEvent | null;
}) {
  const oldHash =
    event?.previousWorkingDefinitionHash ??
    receipt?.previousWorkingDefinitionHash ??
    null;
  const newHash =
    event?.workingDefinitionHash ?? receipt?.workingDefinitionHash ?? null;
  if (oldHash === null) return null;
  const contextIds = event?.addedContextIds ?? receipt?.addedContextIds ?? [];
  const taskIds = event?.addedTaskIds ?? receipt?.addedTaskIds ?? [];
  const edgeIds = event?.addedEdgeIds ?? receipt?.addedEdgeIds ?? [];
  return (
    <div className="mt-md rounded-md border border-solid border-[var(--cc-green-border)] bg-green-glow p-sm">
      <p className="m-0 font-mono text-[0.68rem] font-bold text-green">
        {event === null ? "Amendment applied" : "Durable amendment event"}
      </p>
      {event !== null && (
        <p className="mt-xs mb-0 font-mono text-[0.64rem] leading-relaxed text-text-primary">
          {event.actor} · {event.reason} · live revision {event.liveRevision}
        </p>
      )}
      <p className="mt-xs mb-0 font-mono text-[0.64rem] leading-relaxed [overflow-wrap:anywhere] text-text-primary">
        additions · contexts {contextIds.join(", ") || "—"} · tasks{" "}
        {taskIds.join(", ") || "—"}
        {" · "}edges {edgeIds.join(", ") || "—"}
      </p>
      <dl className="mt-xs mb-0 grid gap-xs font-mono text-[0.62rem] [overflow-wrap:anywhere]">
        <div>
          <dt className="text-text-tertiary">OLD WORKING-DEFINITION HASH</dt>
          <dd className="m-0 text-text-primary">{oldHash}</dd>
        </div>
        <div>
          <dt className="text-text-tertiary">NEW WORKING-DEFINITION HASH</dt>
          <dd className="m-0 text-text-primary">{newHash ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

function AmendCard({
  canRequest,
  pending,
  receipt,
  event,
  failure,
  onAmend,
}: {
  canRequest: boolean;
  pending: boolean;
  receipt: WorkflowAmendmentReceipt | null;
  event: GraphWorkflowExecutionAmendedEvent | null;
  failure: PostLaunchFailure | null;
  onAmend(request: WorkflowExecutionAmendmentRequest): void;
}) {
  const [reason, setReason] = useState("");
  const [additionType, setAdditionType] = useState<AdditionType>("add-task");
  const [operations, setOperations] = useState<WorkflowAmendmentOperation[]>(
    [],
  );
  const [contextId, setContextId] = useState("");
  const [contextTitle, setContextTitle] = useState("");
  const [acceptanceCriteria, setAcceptanceCriteria] = useState("");
  const [contextDescription, setContextDescription] = useState("");
  const [taskId, setTaskId] = useState("");
  const [taskContextId, setTaskContextId] = useState("");
  const [taskTitle, setTaskTitle] = useState("");
  const [taskInstructions, setTaskInstructions] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [sourceContextId, setSourceContextId] = useState("");
  const [targetContextId, setTargetContextId] = useState("");

  const additionReady =
    additionType === "add-context"
      ? contextId.trim().length > 0 &&
        contextTitle.trim().length > 0 &&
        acceptanceCriteria.trim().length > 0
      : additionType === "add-task"
        ? taskId.trim().length > 0 &&
          taskContextId.trim().length > 0 &&
          taskTitle.trim().length > 0 &&
          taskInstructions.trim().length > 0
        : edgeId.trim().length > 0 &&
          sourceContextId.trim().length > 0 &&
          targetContextId.trim().length > 0;

  function queueOperation(): void {
    if (!additionReady) return;
    if (additionType === "add-context") {
      setOperations((current) => [
        ...current,
        {
          type: "add-context",
          id: contextId.trim(),
          title: contextTitle.trim(),
          acceptanceCriteria: acceptanceCriteria.trim(),
          ...(contextDescription.trim().length === 0
            ? {}
            : { description: contextDescription.trim() }),
        },
      ]);
      setContextId("");
      setContextTitle("");
      setAcceptanceCriteria("");
      setContextDescription("");
      return;
    }
    if (additionType === "add-task") {
      setOperations((current) => [
        ...current,
        {
          type: "add-task",
          id: taskId.trim(),
          contextId: taskContextId.trim(),
          title: taskTitle.trim(),
          instructions: taskInstructions.trim(),
        },
      ]);
      setTaskId("");
      setTaskContextId("");
      setTaskTitle("");
      setTaskInstructions("");
      return;
    }
    setOperations((current) => [
      ...current,
      {
        type: "add-edge",
        id: edgeId.trim(),
        sourceContextId: sourceContextId.trim(),
        targetContextId: targetContextId.trim(),
      },
    ]);
    setEdgeId("");
    setSourceContextId("");
    setTargetContextId("");
  }

  function applyAmendment(): void {
    onAmend({ reason: reason.trim(), operations });
  }

  return (
    <section aria-label="Amend current run" className={cardClass}>
      <CardHeading index="03" title="Amend current run" tone="cyan">
        Add contexts, tasks, or edges to the working definition under its pinned
        mutability policy.
      </CardHeading>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel htmlFor="post-launch-amend-reason">Rationale</FormLabel>
        <FormInput
          id="post-launch-amend-reason"
          aria-label="Amendment rationale"
          value={reason}
          onChange={(event) => setReason(event.currentTarget.value)}
          placeholder="Required durable rationale"
          autoComplete="off"
        />
      </FormGroup>
      <FormGroup layoutClassName="mb-sm">
        <FormLabel>Addition type</FormLabel>
        <Select
          value={additionType}
          onValueChange={(value) => setAdditionType(value as AdditionType)}
        >
          <SelectTrigger aria-label="Addition type" layoutClassName="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="add-context">Context</SelectItem>
            <SelectItem value="add-task">Task</SelectItem>
            <SelectItem value="add-edge">Edge</SelectItem>
          </SelectContent>
        </Select>
      </FormGroup>

      {additionType === "add-context" && (
        <div>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-context-id">Context id</FormLabel>
            <FormInput
              id="post-launch-context-id"
              value={contextId}
              onChange={(event) => setContextId(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-context-title">
              Context title
            </FormLabel>
            <FormInput
              id="post-launch-context-title"
              value={contextTitle}
              onChange={(event) => setContextTitle(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-context-criteria">
              Acceptance criteria
            </FormLabel>
            <FormInput
              id="post-launch-context-criteria"
              value={acceptanceCriteria}
              onChange={(event) =>
                setAcceptanceCriteria(event.currentTarget.value)
              }
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-context-description">
              Description
            </FormLabel>
            <FormInput
              id="post-launch-context-description"
              value={contextDescription}
              onChange={(event) =>
                setContextDescription(event.currentTarget.value)
              }
            />
          </FormGroup>
        </div>
      )}
      {additionType === "add-task" && (
        <div>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-task-id">Task id</FormLabel>
            <FormInput
              id="post-launch-task-id"
              value={taskId}
              onChange={(event) => setTaskId(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-task-context-id">
              Target context id
            </FormLabel>
            <FormInput
              id="post-launch-task-context-id"
              value={taskContextId}
              onChange={(event) => setTaskContextId(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-task-title">Task title</FormLabel>
            <FormInput
              id="post-launch-task-title"
              value={taskTitle}
              onChange={(event) => setTaskTitle(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-task-instructions">
              Task instructions
            </FormLabel>
            <FormInput
              id="post-launch-task-instructions"
              value={taskInstructions}
              onChange={(event) =>
                setTaskInstructions(event.currentTarget.value)
              }
            />
          </FormGroup>
        </div>
      )}
      {additionType === "add-edge" && (
        <div>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-edge-id">Edge id</FormLabel>
            <FormInput
              id="post-launch-edge-id"
              value={edgeId}
              onChange={(event) => setEdgeId(event.currentTarget.value)}
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-edge-source">
              Source context id
            </FormLabel>
            <FormInput
              id="post-launch-edge-source"
              value={sourceContextId}
              onChange={(event) =>
                setSourceContextId(event.currentTarget.value)
              }
            />
          </FormGroup>
          <FormGroup layoutClassName="mb-sm">
            <FormLabel htmlFor="post-launch-edge-target">
              Target context id
            </FormLabel>
            <FormInput
              id="post-launch-edge-target"
              value={targetContextId}
              onChange={(event) =>
                setTargetContextId(event.currentTarget.value)
              }
            />
          </FormGroup>
        </div>
      )}

      <Button
        size="sm"
        touch
        disabled={!additionReady}
        onClick={queueOperation}
      >
        Queue{" "}
        {additionType === "add-context"
          ? "context"
          : additionType === "add-task"
            ? "task"
            : "edge"}{" "}
        addition
      </Button>
      <QueuedOperations
        operations={operations}
        onRemove={(index) =>
          setOperations((current) =>
            current.filter((_, candidate) => candidate !== index),
          )
        }
      />
      {!canRequest && (
        <FormHint>
          Launch the plan in a session before requesting a current-run
          amendment.
        </FormHint>
      )}
      <Button
        size="sm"
        variant="primary"
        touch
        layoutClassName="mt-md self-start"
        loading={pending}
        disabled={
          !canRequest || reason.trim().length === 0 || operations.length === 0
        }
        onClick={applyAmendment}
      >
        Apply amendment
      </Button>
      <AmendmentReceipt receipt={receipt} event={event} />
      {failure !== null && <FailureNotice failure={failure} />}
    </section>
  );
}

export default function PostLaunchCapturePaths({
  projectName,
  slug,
  executionId,
  state,
  canRequestAmendment,
  capturePending,
  captureOutcomePath,
  captureReceipt,
  captureFailure,
  amendmentPending,
  amendmentReceipt,
  amendmentEvent,
  amendmentFailure,
  onCapture,
  onAmend,
}: PostLaunchCapturePathsProps): React.JSX.Element {
  const planHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=plan`;
  const discoveryReceipt =
    captureOutcomePath === "discovery" && captureReceipt?.replacement === null
      ? captureReceipt
      : null;
  const replanReceipt =
    captureOutcomePath === "replan" && captureReceipt?.replacement !== null
      ? captureReceipt
      : null;

  return (
    <section
      aria-label="Post-launch capture"
      data-layout="three-paths"
      className="mt-md rounded-lg border border-solid border-border-subtle bg-bg-base p-md"
    >
      <header className="mb-md flex flex-wrap items-end justify-between gap-sm">
        <div>
          <p className="m-0 font-mono text-[0.65rem] font-bold tracking-[0.08em] text-text-tertiary uppercase">
            Post-launch capture
          </p>
          <h2 className="mt-xs mb-0 font-display text-[0.92rem] font-extrabold text-text-primary">
            Choose where discovered work belongs
          </h2>
        </div>
        <StatusChip tone={state === "running" ? "cyan" : "amber"}>
          {state === "running"
            ? `${executionId ?? "execution"} · pinned scope`
            : "Unlaunched attempt"}
        </StatusChip>
      </header>
      <div className="grid grid-cols-3 items-start gap-md max-960:grid-cols-1">
        <DiscoveryCard
          executionId={executionId}
          state={state}
          planHref={planHref}
          pending={capturePending && captureOutcomePath === "discovery"}
          receipt={discoveryReceipt}
          failure={captureOutcomePath === "discovery" ? captureFailure : null}
          onCapture={(request) => onCapture("discovery", request)}
        />
        <ReplanCard
          executionId={executionId}
          state={state}
          planHref={planHref}
          pending={capturePending && captureOutcomePath === "replan"}
          receipt={replanReceipt}
          failure={captureOutcomePath === "replan" ? captureFailure : null}
          onCapture={(request) => onCapture("replan", request)}
        />
        <AmendCard
          canRequest={canRequestAmendment}
          pending={amendmentPending}
          receipt={amendmentReceipt}
          event={amendmentEvent}
          failure={amendmentFailure}
          onAmend={onAmend}
        />
      </div>
    </section>
  );
}
