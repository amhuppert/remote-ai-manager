"use client";

import Link from "next/link";
import { useState } from "react";

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
import { StatusChip } from "@/components/ui/StatusChip";
import type { TaskElementPayload } from "@/lib/specs/schemas";

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

export interface PostLaunchFailure {
  message: string;
  instruction: string | null;
}

export interface PostLaunchCapturePathsProps {
  projectName: string;
  slug: string;
  executionId: string | null;
  state: "running" | "unlaunched";
  capturePending: boolean;
  captureOutcomePath: "discovery" | "replan" | null;
  captureReceipt: CaptureScopeAmendmentReceipt | null;
  captureFailure: PostLaunchFailure | null;
  onCapture(
    path: "discovery" | "replan",
    request: CaptureDiscoveredWorkRequest,
  ): void;
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

export default function PostLaunchCapturePaths({
  projectName,
  slug,
  executionId,
  state,
  capturePending,
  captureOutcomePath,
  captureReceipt,
  captureFailure,
  onCapture,
}: PostLaunchCapturePathsProps): React.JSX.Element {
  const planHref = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=delivery`;
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
      data-layout="capture-paths"
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
      <div className="grid grid-cols-2 items-start gap-md max-960:grid-cols-1">
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
      </div>
    </section>
  );
}
