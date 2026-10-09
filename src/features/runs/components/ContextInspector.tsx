"use client";

import { useEffect, useRef, useState } from "react";
import ApprovalGatePanel, {
  ScopedChangesSection,
} from "@/components/ApprovalGatePanel";
import {
  ArrowUpRightIcon,
  BranchIcon,
  CheckIcon,
  CloseIcon,
  DocumentIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { JsonTree } from "@/components/ui/JsonTree";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import {
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
  TabsTriggerCount,
} from "@/components/ui/Tabs";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { formatLocalTime } from "@/lib/shared/format-local-time";
import { cn } from "@/lib/ui/cn";
import { LoopIcon, QuestionIcon, WaitingIcon } from "../icons";
import type {
  ContextDetail,
  ContextInvocation,
  RunOwner,
  SeatConversation,
} from "../model";
import { contextState, formatUsd } from "../present";
import { HaltCard, type RemedyChoice } from "./HaltCard";
import { KeyLabel, PanelHeading, SeatMark } from "./parts";
import { ReviewRounds } from "./ReviewRounds";
import { StageTrack } from "./StageTrack";

export interface ContextActions {
  onApplyRemedy(contextKey: string, choice: RemedyChoice): void | Promise<void>;
  onApprove(contextKey: string, candidateId: string): void | Promise<void>;
  onReject(
    contextKey: string,
    candidateId: string,
    notes: string,
  ): void | Promise<void>;
  onOpenConversation(conversationId: string): void;
  onOpenDocument(path: string, revision: number): void;
  onOpenCharter(revision: number, contextKey: string): void;
}

const seatStatus: Record<
  SeatConversation["status"],
  { label: string; tone: StatusChipTone }
> = {
  active: { label: "Working", tone: "cyan" },
  idle: { label: "Idle", tone: "neutral" },
  replaced: { label: "Replaced", tone: "amber" },
  finished: { label: "Finished", tone: "neutral" },
};

function Callout({
  tone,
  icon,
  title,
  children,
}: {
  tone: "amber" | "neutral";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex gap-md rounded-lg border border-solid px-lg py-md",
        tone === "amber"
          ? "border-[var(--cc-amber-a25)] bg-amber-glow"
          : "border-border-subtle bg-bg-surface",
      )}
    >
      <span
        className={cn(
          "mt-[1px] shrink-0",
          tone === "amber" ? "text-amber" : "text-text-tertiary",
        )}
      >
        {icon}
      </span>
      <div className="flex min-w-0 flex-col gap-[4px]">
        <h3
          className={cn(
            "m-0 font-mono text-[0.78rem] font-semibold",
            tone === "amber" ? "text-amber" : "text-text-primary",
          )}
        >
          {title}
        </h3>
        <div className="font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
          {children}
        </div>
      </div>
    </section>
  );
}

/** What the state asks of the person, above the tabs. */
function StateAction({
  context,
  actions,
  runSuspended,
  now,
}: {
  context: ContextInvocation;
  actions: ContextActions;
  runSuspended: boolean;
  now?: number;
}) {
  const { state } = context;
  const [pending, setPending] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const inFlight = useRef(false);
  const submit = async (action: () => void | Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setRefusal(null);
    try {
      await action();
    } catch (error) {
      setRefusal(
        error instanceof Error
          ? error.message
          : "The decision could not be applied. Refresh the run and try again.",
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const refusalMessage =
    refusal !== null ? (
      <p
        role="alert"
        className="m-0 rounded-md border border-solid border-red-dim bg-red-glow px-md py-sm font-mono text-[0.75rem] leading-relaxed text-red-text"
      >
        {refusal}
      </p>
    ) : null;
  switch (state.kind) {
    case "halted":
      return (
        <div className="flex flex-col gap-sm">
          {refusalMessage}
          <HaltCard
            halt={state.halt}
            submitting={pending}
            runSuspended={runSuspended}
            onApply={(choice) => {
              void submit(() => actions.onApplyRemedy(context.key, choice));
            }}
          />
        </div>
      );
    case "awaiting_approval": {
      const approval = context.approval;
      return approval === null ? null : (
        <div className="flex flex-col gap-sm">
          {refusalMessage}
          <ApprovalGatePanel
            contextTitle={context.title}
            workflowName={null}
            requestedAt={approval.requestedAt}
            now={now}
            isSubmitting={pending}
            conversationBusy={false}
            executionSuspended={runSuspended}
            scopedChanges={
              context.candidate === null
                ? {
                    status: "unavailable",
                    reason: "The candidate's changes are not loaded.",
                  }
                : {
                    status: "ready",
                    candidate: context.candidate,
                  }
            }
            onApprove={() => {
              void submit(() =>
                actions.onApprove(context.key, approval.candidateId),
              );
            }}
            onReject={(notes) => {
              void submit(() =>
                actions.onReject(context.key, approval.candidateId, notes),
              );
            }}
          />
        </div>
      );
    }
    case "waiting": {
      const hasBlockers =
        state.dependencies.length +
          state.provisionLanes.length +
          state.publicationLanes.length >
        0;
      return (
        <Callout
          tone="neutral"
          icon={<WaitingIcon size={16} />}
          title={hasBlockers ? "Waiting to start" : "Ready to start"}
        >
          <div className="flex flex-col gap-xs">
            {state.dependencies.length > 0 ? (
              <p className="m-0">
                Waiting for {state.dependencies.join(", ")} to succeed.
              </p>
            ) : null}
            {state.provisionLanes.map((lane) => (
              <p key={lane} className="m-0">
                Lane {lane} must finish setting up.
              </p>
            ))}
            {state.publicationLanes.map((lane) => (
              <p key={lane} className="m-0">
                Lane {lane} must publish into the session branch.
              </p>
            ))}
            {!hasBlockers ? (
              <p className="m-0">No dependency or workspace blockers remain.</p>
            ) : null}
          </div>
        </Callout>
      );
    }
    case "skipped":
      return (
        <Callout
          tone="neutral"
          icon={<WaitingIcon size={16} />}
          title="Skipped"
        >
          Its route was not taken: {state.reason}.
        </Callout>
      );
    default:
      return null;
  }
}

function OverviewTab({ context }: { context: ContextInvocation }) {
  return (
    <div className="flex flex-col gap-xl">
      <section className="flex flex-col gap-sm">
        <PanelHeading>Brief</PanelHeading>
        <p className="m-0 font-mono text-[0.78rem] leading-[1.6] text-text-primary">
          {context.brief}
        </p>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading
          count={`${context.taskList.filter((task) => task.done).length}/${context.taskList.length}`}
        >
          Tasks
        </PanelHeading>
        <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
          {context.taskList.map((task) => (
            <li
              key={task.id}
              className="flex items-start gap-sm font-mono text-[0.78rem]"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "mt-[2px] inline-flex size-[14px] shrink-0 items-center justify-center rounded-sm border border-solid",
                  task.done
                    ? "border-[var(--cc-green-a20)] bg-green-glow text-green"
                    : "border-border-default text-transparent",
                )}
              >
                <CheckIcon size={10} />
              </span>
              <span
                className={
                  task.done ? "text-text-secondary" : "text-text-primary"
                }
              >
                <span className="sr-only">
                  {task.done ? "Done: " : "Pending: "}
                </span>
                {task.title}
              </span>
              <span className="ml-auto shrink-0 text-[0.7rem] text-text-tertiary">
                {task.id}
              </span>
            </li>
          ))}
        </ul>
      </section>
      {context.criteria.length > 0 ? (
        <section className="flex flex-col gap-sm">
          <PanelHeading count={context.criteria.length}>
            Acceptance criteria
          </PanelHeading>
          <ol className="m-0 flex list-none flex-col gap-[6px] p-0">
            {context.criteria.map((criterion) => (
              <li
                key={criterion.id}
                className="flex items-baseline gap-sm font-mono text-[0.78rem] leading-[1.5]"
              >
                <span className="w-[34px] shrink-0 text-[0.7rem] text-text-tertiary">
                  {criterion.id}
                </span>
                <span className="text-text-primary">{criterion.text}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {context.lastSummary !== null ? (
        <section className="flex flex-col gap-sm">
          <PanelHeading>Last report</PanelHeading>
          <blockquote className="m-0 rounded-md border-y-0 border-r-0 border-l-2 border-solid border-border-strong bg-bg-base px-md py-sm font-body text-[0.82rem] leading-[1.6] text-text-primary">
            {context.lastSummary}
          </blockquote>
        </section>
      ) : null}
    </div>
  );
}

function ResultTab({ context }: { context: ContextInvocation }) {
  return (
    <div className="flex flex-col gap-xl">
      <section className="flex flex-col gap-sm">
        <PanelHeading
          trailing={
            context.output !== null ? (
              <StatusChip
                tone={context.output.status === "accepted" ? "green" : "amber"}
              >
                {context.output.status === "accepted"
                  ? "Accepted"
                  : "Candidate"}
              </StatusChip>
            ) : undefined
          }
        >
          Result
        </PanelHeading>
        {context.output === null ? (
          <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
            No result yet.
          </p>
        ) : (
          <div className="relative rounded-md border border-solid border-border-subtle bg-bg-base">
            <JsonTree value={context.output.value} copyable />
          </div>
        )}
      </section>
      {context.candidate !== null ? (
        <section className="flex flex-col gap-sm">
          <PanelHeading>Candidate changes</PanelHeading>
          <ScopedChangesSection
            ownedPaths={
              context.candidate.scope === "owned"
                ? context.candidate.ownedPaths
                : null
            }
            diff={context.candidate.diff}
          />
        </section>
      ) : null}
      <section className="flex flex-col gap-sm">
        <PanelHeading count={context.inputs.length}>Inputs</PanelHeading>
        {context.inputs.length === 0 ? (
          <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
            It builds on no earlier result.
          </p>
        ) : (
          context.inputs.map((input) => (
            <div
              key={`${input.key}-${input.title}`}
              className="flex flex-col gap-[6px]"
            >
              <div className="flex items-baseline gap-sm">
                <KeyLabel>{input.key}</KeyLabel>
                <span className="font-mono text-[0.72rem] text-text-secondary">
                  {input.title}
                </span>
              </div>
              <div className="rounded-md border border-solid border-border-dim bg-bg-base">
                <JsonTree value={input.output} defaultCollapsedDepth={1} />
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

function AgentsTab({
  context,
  actions,
}: {
  context: ContextInvocation;
  actions: ContextActions;
}) {
  if (context.agents.length === 0)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        No agent has started.
      </p>
    );
  return (
    <ul className="m-0 flex list-none flex-col gap-sm p-0">
      {context.agents.map((agent) => (
        <li
          key={agent.conversationId}
          className="flex items-center gap-md rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-sm"
        >
          <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
            <div className="flex min-w-0 items-center gap-sm">
              <span className="font-mono text-[0.72rem] font-semibold text-text-primary">
                {agent.seat.role === "implementer"
                  ? "Implementer"
                  : (agent.seat.focus ?? "Reviewer")}
              </span>
              {agent.seat.authority !== undefined ? (
                <span className="font-mono text-[0.7rem] text-text-tertiary">
                  {agent.seat.authority}
                </span>
              ) : null}
              <StatusChip
                tone={seatStatus[agent.status].tone}
                layoutClassName="ml-auto"
              >
                {seatStatus[agent.status].label}
              </StatusChip>
            </div>
            <div className="flex min-w-0 items-center gap-md">
              <SeatMark seat={agent.seat} />
              <span className="shrink-0 font-mono text-[0.7rem] text-text-tertiary">
                {agent.turns} {agent.turns === 1 ? "turn" : "turns"} ·{" "}
                {formatUsd(agent.costUsd)}
              </span>
            </div>
            {agent.replacedBecause !== undefined ? (
              <span className="font-mono text-[0.7rem] text-amber">
                {agent.replacedBecause}
              </span>
            ) : null}
          </div>
          <WithTooltip label="Open transcript">
            <IconButton
              variant="ghost"
              aria-label={`Open the ${agent.assignment} transcript`}
              onClick={() => actions.onOpenConversation(agent.conversationId)}
            >
              <ArrowUpRightIcon />
            </IconButton>
          </WithTooltip>
        </li>
      ))}
    </ul>
  );
}

function DocumentsTab({
  context,
  actions,
}: {
  context: ContextInvocation;
  actions: ContextActions;
}) {
  if (context.froze === null)
    return (
      <p className="m-0 font-mono text-[0.72rem] text-text-tertiary">
        It freezes the run&apos;s charter and documents when it starts.
      </p>
    );
  return (
    <div className="flex flex-col gap-md">
      <p className="m-0 font-mono text-[0.72rem] leading-[1.55] text-text-secondary">
        Frozen when it started. Later revisions reach only work that starts
        after them.
      </p>
      <ul className="m-0 flex list-none flex-col gap-[2px] p-0">
        {context.froze.charter !== null ? (
          <li>
            <button
              type="button"
              onClick={() => {
                if (
                  context.froze?.charter !== null &&
                  context.froze?.charter !== undefined
                )
                  actions.onOpenCharter(context.froze.charter, context.key);
              }}
              className="flex w-full cursor-pointer items-center gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-md text-left font-mono text-[0.78rem] transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              <span className="text-text-tertiary">
                <DocumentIcon size={14} />
              </span>
              <span className="text-text-primary">charter.md</span>
              <span className="ml-auto text-[0.7rem] text-text-tertiary">
                revision {context.froze.charter}
              </span>
              <ArrowUpRightIcon size={13} />
            </button>
          </li>
        ) : null}
        {context.froze.documents.map((document) => (
          <li key={document.path}>
            <button
              type="button"
              onClick={() =>
                actions.onOpenDocument(document.path, document.revision)
              }
              className="flex w-full cursor-pointer flex-wrap items-center gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-md text-left font-mono text-[0.78rem] transition-colors duration-150 hover:bg-bg-raised focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
            >
              <span className="text-text-tertiary">
                <DocumentIcon size={14} />
              </span>
              <span className="min-w-0 [overflow-wrap:anywhere] break-words text-text-primary">
                {document.path}
              </span>
              {document.later !== null ? (
                <StatusChip tone="amber">
                  {document.later === "removed"
                    ? "removed from run"
                    : "newer revision"}
                </StatusChip>
              ) : null}
              <span className="ml-auto shrink-0 text-[0.7rem] text-text-tertiary">
                revision {document.revision}
              </span>
              <ArrowUpRightIcon size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfigurationRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] items-start gap-md border-x-0 border-t-0 border-b border-solid border-border-subtle py-sm last:border-b-0 max-640:grid-cols-1 max-640:gap-xs">
      <dt className="font-mono text-[0.72rem] leading-relaxed text-text-secondary">
        {label}
      </dt>
      <dd className="m-0 min-w-0 font-mono text-[0.72rem] leading-relaxed [overflow-wrap:anywhere] break-words text-text-primary">
        {children}
      </dd>
    </div>
  );
}

function ConfigurationTab({ context }: { context: ContextInvocation }) {
  const config = context.configuration;
  const policy = config.policy;
  const seats = [context.implementer, ...context.reviewers];
  return (
    <div className="flex flex-col gap-xl">
      <p className="m-0 font-mono text-[0.72rem] leading-relaxed text-text-secondary">
        {context.startedAt === null
          ? "Resolved settings for this context. They freeze when it starts."
          : "Contract frozen when this invocation started. Retry allowances include later grants."}
      </p>
      <section className="flex flex-col gap-sm">
        <PanelHeading>Workspace</PanelHeading>
        <dl className="m-0">
          <ConfigurationRow label="Placement">
            {context.placement.kind === "lane"
              ? `Lane ${context.placement.lane}`
              : "Session worktree"}
          </ConfigurationRow>
          <ConfigurationRow label="Branch">{config.branch}</ConfigurationRow>
          <ConfigurationRow label="Worktree">
            {config.worktreePath}
          </ConfigurationRow>
          <ConfigurationRow label="Write access">
            {config.scope.mode === "full"
              ? "Full worktree"
              : config.scope.mode === "readOnly"
                ? "Read-only"
                : "Owned paths"}
          </ConfigurationRow>
          {config.scope.mode === "owned" ? (
            <ConfigurationRow label="Owned paths">
              <ul className="m-0 flex list-none flex-col gap-xs p-0">
                {config.scope.paths.map((path) => (
                  <li key={path}>{path}</li>
                ))}
              </ul>
            </ConfigurationRow>
          ) : null}
        </dl>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading count={seats.length}>Seats</PanelHeading>
        <ul className="m-0 flex list-none flex-col gap-sm p-0">
          {seats.map((seat, index) => (
            <li
              key={index}
              className="flex flex-col gap-sm rounded-md border border-solid border-border-subtle bg-bg-base p-md"
            >
              <span className="flex flex-wrap items-center gap-sm font-mono text-[0.72rem] font-medium text-text-primary">
                {seat.role === "implementer"
                  ? "Implementer"
                  : (seat.focus ?? "Reviewer")}
                {seat.authority !== undefined ? (
                  <StatusChip tone="neutral">{seat.authority}</StatusChip>
                ) : null}
              </span>
              <SeatMark seat={seat} />
              <span className="font-mono text-[0.7rem] text-text-secondary">
                Profile: {seat.profile ?? "none"}
              </span>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading>Review and permissions</PanelHeading>
        <dl className="m-0">
          <ConfigurationRow label="Checks">
            {config.checks.length > 0 ? config.checks.join(", ") : "None"}
          </ConfigurationRow>
          {config.deferredChecks.length > 0 ? (
            <ConfigurationRow label="Deferred checks">
              <span>{config.deferredChecks.join(", ")}</span>
              <p className="m-0 mt-xs text-text-secondary">
                Run later on the assembled tree.
              </p>
            </ConfigurationRow>
          ) : null}
          <ConfigurationRow label="Human approval">
            {context.humanApproval ? "Required" : "Not required"}
          </ConfigurationRow>
          <ConfigurationRow label="Owner questions">
            {config.ownerQuestions ? "Allowed" : "Disabled"}
          </ConfigurationRow>
          <ConfigurationRow label="Task additions">
            {config.allowTaskAddition ? "Allowed" : "Disabled"}
          </ConfigurationRow>
          <ConfigurationRow label="Publish documents">
            {config.documentPublishing ? "Allowed" : "Disabled"}
          </ConfigurationRow>
        </dl>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading>Allowances and limits</PanelHeading>
        <dl className="m-0">
          <ConfigurationRow label="Unfinished task retries">
            {policy.unfinishedTaskRetries.used} used ·{" "}
            {policy.unfinishedTaskRetries.limit} allowed
          </ConfigurationRow>
          <ConfigurationRow label="Validation retries">
            {policy.validationRetries.used} used ·{" "}
            {policy.validationRetries.limit} allowed
          </ConfigurationRow>
          <ConfigurationRow label="Output repairs">
            {policy.captureRepairLimit}
          </ConfigurationRow>
          <ConfigurationRow label="Candidate instability limit">
            {policy.instabilityLimit}
          </ConfigurationRow>
          <ConfigurationRow label="Advice corrections">
            {policy.adviceCorrectionLimit}
          </ConfigurationRow>
          <ConfigurationRow label="Invocation timeout">
            {policy.invocationTimeoutMs === null
              ? "No limit"
              : `${policy.invocationTimeoutMs / 60_000} minutes`}
          </ConfigurationRow>
        </dl>
      </section>
      <section className="flex flex-col gap-sm">
        <PanelHeading>Output schema</PanelHeading>
        {config.outputSchema === null ? (
          <p className="m-0 font-mono text-[0.72rem] text-text-secondary">
            No structured output required.
          </p>
        ) : (
          <div className="min-w-0 overflow-x-auto rounded-md border border-solid border-border-subtle bg-bg-base">
            <JsonTree
              value={config.outputSchema}
              defaultCollapsedDepth={3}
              copyable
            />
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * One context in full: where it is, what it needs from the person, and its
 * tasks, reviews, result, agents and frozen documents.
 */
export function ContextInspector({
  context: currentContext,
  owner,
  actions,
  runSuspended = false,
  actionRequest = 0,
  now,
  onClose,
  embedded = false,
}: {
  context: ContextDetail;
  owner: RunOwner;
  actions: ContextActions;
  runSuspended?: boolean;
  /** Increment to show and focus the current action without discarding its draft. */
  actionRequest?: number;
  now?: number;
  onClose?(): void;
  /** An agent run's only context, under the run's own header: no second title. */
  embedded?: boolean;
}) {
  const [selection, setSelection] = useState({
    invocation: "current",
    actionRequest,
  });
  const invocation =
    selection.actionRequest === actionRequest
      ? selection.invocation
      : "current";
  const previous = currentContext.previousInvocations.find(
    (previous) => previous.invocationId === invocation,
  );
  const historical = invocation !== "current" && previous !== undefined;
  const context = historical ? previous : currentContext;
  const actionRef = useRef<HTMLElement>(null);
  const focusedRequest = useRef(0);
  const actionable =
    context.state.kind === "halted" ||
    context.state.kind === "awaiting_approval";
  const actionIdentity =
    context.state.kind === "halted"
      ? context.state.halt.occurrence
      : (context.approval?.candidateId ?? context.invocationId);
  useEffect(() => {
    if (
      actionRequest === 0 ||
      focusedRequest.current === actionRequest ||
      historical ||
      !actionable
    )
      return;
    focusedRequest.current = actionRequest;
    actionRef.current?.focus({ preventScroll: true });
    actionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [actionRequest, historical, actionable]);
  const state = contextState(context.state);
  const placement =
    context.placement.kind === "lane"
      ? `lane ${context.placement.lane}`
      : "session worktree";
  return (
    <div className="flex flex-col gap-lg">
      {embedded ? null : (
        <header className="flex flex-col gap-sm">
          <div className="flex items-start gap-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-[4px]">
              <KeyLabel>{context.key}</KeyLabel>
              <h2 className="m-0 font-display text-[1.15rem] leading-[1.2] font-bold text-text-primary">
                {context.title}
              </h2>
            </div>
            <StatusChip tone={state.tone} layoutClassName="mt-[2px]">
              {context.state.kind === "waiting" ? "Not started" : state.label}
            </StatusChip>
            {onClose !== undefined ? (
              <WithTooltip label="Close">
                <IconButton
                  variant="ghost"
                  aria-label="Close context"
                  onClick={onClose}
                >
                  <CloseIcon size={18} />
                </IconButton>
              </WithTooltip>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-md gap-y-[4px] font-mono text-[0.72rem] text-text-secondary">
            <span className="inline-flex items-center gap-[6px]">
              <BranchIcon size={13} />
              {placement}
            </span>
            {context.loop !== null ? (
              <span className="inline-flex items-center gap-[6px]">
                <LoopIcon size={13} />
                {context.loop.key} · pass {context.loop.pass} of{" "}
                {context.loop.maxPasses}
              </span>
            ) : null}
            {context.startedAt !== null ? (
              <span>started {formatLocalTime(context.startedAt)}</span>
            ) : null}
            <span>{formatUsd(context.costUsd)}</span>
          </div>
        </header>
      )}

      {currentContext.previousInvocations.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-sm rounded-md border border-solid border-border-subtle bg-bg-surface px-md py-sm">
          <span className="font-mono text-[0.72rem] text-text-secondary">
            Invocation
          </span>
          <Select
            value={invocation}
            onValueChange={(invocation) =>
              setSelection({ invocation, actionRequest })
            }
          >
            <SelectTrigger aria-label="Invocation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="current">
                Pass {currentContext.loop?.pass ?? 1} · current
              </SelectItem>
              {currentContext.previousInvocations.map((previous) => (
                <SelectItem
                  key={previous.invocationId}
                  value={previous.invocationId}
                >
                  Pass {previous.loop?.pass ?? 1} ·{" "}
                  {contextState(previous.state).label.toLowerCase()}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      {historical ? (
        <p
          role="status"
          className="m-0 rounded-md border border-solid border-border-subtle bg-bg-base px-md py-sm font-mono text-[0.72rem] leading-relaxed text-text-secondary"
        >
          Earlier pass · read-only. Its results, reviews and frozen documents
          stay as recorded.
        </p>
      ) : null}

      <div className="rounded-lg border border-solid border-border-subtle bg-bg-base px-md pt-md pb-sm">
        <StageTrack
          stages={context.stages}
          paused={
            runSuspended ||
            context.state.kind === "paused" ||
            context.state.kind === "stopping"
          }
        />
      </div>

      {historical ? null : actionable ? (
        <section
          ref={actionRef}
          aria-label="Current context action"
          tabIndex={-1}
          className="rounded-lg focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
        >
          <StateAction
            key={actionIdentity}
            context={context}
            actions={actions}
            runSuspended={runSuspended}
            now={now}
          />
        </section>
      ) : (
        <StateAction
          context={context}
          actions={actions}
          runSuspended={runSuspended}
          now={now}
        />
      )}

      {context.questions.map((question) => (
        <Callout
          key={question.questionId}
          tone="amber"
          icon={<QuestionIcon size={16} />}
          title={`${question.seat} asked ${owner.title}`}
        >
          <p className="m-0 text-text-primary">{question.question}</p>
          <p className="m-0 mt-xs">
            The owner conversation answers or asks you. Other reviewers can
            continue.
          </p>
          <Button
            touch
            size="sm"
            variant="ghost"
            layoutClassName="mt-sm -ml-md"
            onClick={() => actions.onOpenConversation(owner.conversationId)}
          >
            Open the owner conversation
            <ArrowUpRightIcon size={12} />
          </Button>
        </Callout>
      ))}

      <TabsRoot
        key={invocation}
        defaultValue="overview"
        layoutClassName="flex flex-col"
      >
        <TabsList layoutClassName="mb-lg self-stretch flex-wrap">
          <TabsTrigger value="overview" touch>
            Overview
          </TabsTrigger>
          <TabsTrigger value="reviews" touch>
            Reviews
            <TabsTriggerCount>{context.reviews.length}</TabsTriggerCount>
          </TabsTrigger>
          <TabsTrigger value="result" touch>
            Result
          </TabsTrigger>
          <TabsTrigger value="agents" touch>
            Agents
            <TabsTriggerCount>{context.agents.length}</TabsTriggerCount>
          </TabsTrigger>
          <TabsTrigger value="documents" touch>
            Documents
          </TabsTrigger>
          <TabsTrigger value="configuration" touch>
            Configuration
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab context={context} />
        </TabsContent>
        <TabsContent value="reviews">
          <ReviewRounds rounds={context.reviews} />
        </TabsContent>
        <TabsContent value="result">
          <ResultTab context={context} />
        </TabsContent>
        <TabsContent value="agents">
          <AgentsTab context={context} actions={actions} />
        </TabsContent>
        <TabsContent value="documents">
          <DocumentsTab context={context} actions={actions} />
        </TabsContent>
        <TabsContent value="configuration">
          <ConfigurationTab context={context} />
        </TabsContent>
      </TabsRoot>
    </div>
  );
}
