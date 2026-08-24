"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import { MultilineInput } from "@/components/MultilineInput";
import { CompactMarkdown } from "@/components/markdown/Markdown";
import { CopyReferenceControl } from "@/components/references/CopyReferenceControl";
import { Button, type ButtonVariant } from "@/components/ui/Button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import { RadioGroup, RadioGroupOption } from "@/components/ui/RadioGroup";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { buildSpecReadCommand } from "@/lib/prompt-editor/spec-reference-contract";
import type { SpecPhaseProjection } from "@/lib/specs/phase";
import type {
  SpecAssumptionDisposition,
  SpecReviewRecordOperation,
} from "@/lib/specs/schemas";
import type {
  SpecAssumptionView,
  SpecQuestionView,
} from "@/lib/specs/view-schemas";
import { cn } from "@/lib/ui/cn";

import { SpecActorAttribution } from "./SpecActorAttribution";
import { settledAtImport } from "./presentation";

const logger = createClientLogger("spec-studio-attention");

function specElementHref(
  projectName: string,
  slug: string,
  handle: string,
): string {
  const path = `/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}`;
  return `${path}?${new URLSearchParams({ el: handle }).toString()}`;
}

type AssumptionChoice = Extract<
  SpecAssumptionDisposition,
  "confirmed" | "rejected" | "deferred"
>;

type MutationState =
  | { state: "idle" }
  | { state: "pending" }
  | { state: "error"; message: string }
  | { state: "success"; message: string };

export interface SpecAttentionRegisterPrototypeProps {
  projectName: string;
  slug: string;
  revision: number;
  phase: SpecPhaseProjection;
  questions: readonly SpecQuestionView[];
  assumptions: readonly SpecAssumptionView[];
  history: readonly (
    | { kind: "question"; record: SpecQuestionView }
    | { kind: "assumption"; record: SpecAssumptionView }
  )[];
  elementHandlesById: ReadonlyMap<string, string>;
  blockingAssumptionIds?: readonly string[];
  historyReasonsById?: Readonly<Record<string, string>>;
  importedAt?: string | null;
  showIntro?: boolean;
  initiallyOpenHistory?: boolean;
  targetHandle?: string | null;
  initialAnswerDrafts?: Readonly<Record<string, string>>;
  initialDispositionChoices?: Readonly<Record<string, AssumptionChoice>>;
  onAnswerQuestion?(input: {
    questionId: string;
    recordVersion: number;
    answer: string;
  }): Promise<void>;
  onDisposeAssumption?(input: {
    assumptionId: string;
    recordVersion: number;
    citationVersion?: number;
    disposition: AssumptionChoice;
  }): Promise<void>;
}

const questionStatus: Record<
  SpecQuestionView["status"],
  { label: string; tone: StatusChipTone }
> = {
  open: { label: "Open", tone: "amber" },
  answered: { label: "Answered", tone: "green" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

const assumptionStatus: Record<
  SpecAssumptionDisposition,
  { label: string; tone: StatusChipTone }
> = {
  proposed: { label: "Proposed", tone: "amber" },
  confirmed: { label: "Confirmed", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  deferred: { label: "Deferred", tone: "neutral" },
  withdrawn: { label: "Withdrawn", tone: "neutral" },
};

const mutationAction: Record<SpecReviewRecordOperation, string> = {
  opened: "Latest event · Opened by",
  proposed: "Latest event · Proposed by",
  imported: "Imported by",
  edited: "Last edited by",
  answered: "Answered by",
  disposed: "Disposed by",
  withdrawn: "Withdrawn by",
  superseded: "Superseded by",
};

const choicePresentation: Record<
  AssumptionChoice,
  { option: string; action: string; variant: ButtonVariant }
> = {
  confirmed: {
    option: "Confirm",
    action: "Confirm assumption",
    variant: "success",
  },
  rejected: {
    option: "Reject",
    action: "Reject assumption",
    variant: "danger",
  },
  deferred: {
    option: "Defer",
    action: "Defer assumption",
    variant: "default",
  },
};

function Attachment({
  elementId,
  elementHandlesById,
}: {
  elementId: string | null;
  elementHandlesById: ReadonlyMap<string, string>;
}): React.JSX.Element {
  if (elementId === null)
    return <StatusChip tone="neutral">Spec-level</StatusChip>;
  return (
    <StatusChip tone="cyan">
      Attached to {elementHandlesById.get(elementId) ?? "unknown element"}
    </StatusChip>
  );
}

function RecordAttribution({
  creationAction,
  creator,
  createdAt,
  lastMutation,
}: {
  creationAction: string;
  creator: SpecQuestionView["provenance"];
  createdAt: string;
  lastMutation: SpecQuestionView["presentation"]["lastMutation"];
}): React.JSX.Element {
  return (
    <div className="mt-sm grid gap-xs">
      <SpecActorAttribution
        action={creationAction}
        actor={creator}
        occurredAt={createdAt}
      />
      {lastMutation !== null ? (
        <SpecActorAttribution
          action={mutationAction[lastMutation.operation]}
          actor={lastMutation.actor}
          occurredAt={lastMutation.occurredAt}
        />
      ) : null}
    </div>
  );
}

function RecordShell({
  handle,
  kind,
  status,
  attachment,
  blocksSignoff,
  projectName,
  slug,
  revision,
  name,
  children,
}: {
  handle: string;
  kind: "question" | "assumption";
  status: { label: string; tone: StatusChipTone };
  attachment: React.ReactNode;
  blocksSignoff?: boolean;
  projectName: string;
  slug: string;
  revision: number;
  name: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const headingId = `${handle}-attention-heading`;
  return (
    <article
      id={handle}
      data-spec-element={handle}
      tabIndex={-1}
      aria-labelledby={headingId}
      className="min-w-0 scroll-mt-[180px] rounded-md border border-solid border-border-dim bg-bg-base p-md focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
    >
      <div className="flex min-w-0 flex-wrap items-start gap-sm">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-xs">
            <h3
              id={headingId}
              className="m-0 font-mono text-[0.76rem] font-bold text-cyan"
            >
              {handle} <span className="sr-only">{kind}</span>
            </h3>
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
            {attachment}
            {blocksSignoff ? (
              <StatusChip tone="red">Blocks sign-off</StatusChip>
            ) : null}
          </div>
        </div>
        <CopyReferenceControl
          referenceType={kind}
          attrs={{
            projectName,
            slug,
            handle,
            name,
            revision: String(revision),
            readCommand: buildSpecReadCommand(projectName, slug, handle),
          }}
        />
      </div>
      {children}
    </article>
  );
}

function CapabilityNotice({
  presentation,
  projectName,
  slug,
}: {
  presentation: SpecQuestionView["presentation"];
  projectName: string;
  slug: string;
}): React.JSX.Element | null {
  const capability = presentation.humanCapability;
  if (
    capability === null ||
    capability.allowed ||
    capability.code === "terminal"
  ) {
    return null;
  }
  if (capability.code === "read_only") {
    return (
      <p className="mt-md mb-0 rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm text-[0.8125rem] leading-relaxed text-text-secondary">
        {capability.instruction}
      </p>
    );
  }
  return (
    <div className="mt-md rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm">
      <p className="m-0 text-[0.8125rem] leading-relaxed text-amber">
        {capability.instruction}
      </p>
      <a
        href={`/specs/${encodeURIComponent(projectName)}/${encodeURIComponent(slug)}?view=review`}
        className="mt-xs inline-flex min-h-[44px] items-center font-mono text-[0.72rem] font-semibold text-amber underline-offset-2 hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
      >
        Open Review
      </a>
    </div>
  );
}

function MutationMessage({
  mutation,
  id,
}: {
  mutation: MutationState;
  id: string;
}): React.JSX.Element | null {
  if (mutation.state === "error") {
    return (
      <p
        id={id}
        role="alert"
        className="mt-sm mb-0 font-mono text-[0.7rem] text-red"
      >
        {mutation.message}
      </p>
    );
  }
  if (mutation.state === "success") {
    return (
      <p
        id={id}
        role="status"
        className="mt-sm mb-0 font-mono text-[0.7rem] text-green"
      >
        {mutation.message}
      </p>
    );
  }
  return null;
}

function QuestionCard({
  question,
  projectName,
  slug,
  revision,
  elementHandlesById,
  draft,
  onDraftChange,
  mutation,
  historyReason,
  importedAt,
  onSubmit,
}: {
  question: SpecQuestionView;
  projectName: string;
  slug: string;
  revision: number;
  elementHandlesById: ReadonlyMap<string, string>;
  draft: string;
  onDraftChange(value: string): void;
  mutation: MutationState;
  historyReason?: string;
  importedAt: string | null;
  onSubmit(): void;
}): React.JSX.Element {
  const messageId = useId();
  const capability = question.presentation.humanCapability;
  const canAnswer = capability?.kind === "answer" && capability.allowed;
  return (
    <RecordShell
      handle={question.handle}
      kind="question"
      status={questionStatus[question.status]}
      attachment={
        <Attachment
          elementId={question.elementId}
          elementHandlesById={elementHandlesById}
        />
      }
      projectName={projectName}
      slug={slug}
      revision={revision}
      name={question.text}
    >
      <RecordAttribution
        creationAction="Asked by"
        creator={question.provenance}
        createdAt={question.createdAt}
        lastMutation={question.presentation.lastMutation}
      />
      <div className="mt-sm min-w-0 text-[0.875rem] leading-relaxed text-text-primary">
        <CompactMarkdown content={question.text} />
      </div>
      {historyReason !== undefined ? (
        <p className="mt-sm mb-0 rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm text-[0.8rem] leading-relaxed text-text-secondary">
          <span className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Reason
          </span>{" "}
          {historyReason}
        </p>
      ) : null}
      {question.status === "answered" ? (
        <div className="mt-md rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm">
          <span className="font-mono text-[0.66rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            {settledAtImport(question.answeredAt, importedAt)
              ? "Answered at import"
              : "Answer"}
          </span>
          <div className="mt-xs min-w-0 text-[0.84rem] leading-relaxed">
            <CompactMarkdown content={question.answer ?? ""} />
          </div>
        </div>
      ) : null}
      {canAnswer ? (
        <div className="mt-md grid gap-sm">
          <label
            htmlFor={`${question.handle}-answer`}
            className="font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase"
          >
            Answer
          </label>
          <MultilineInput
            id={`${question.handle}-answer`}
            aria-label={`Answer for ${question.handle}`}
            aria-describedby={
              mutation.state === "idle" || mutation.state === "pending"
                ? undefined
                : messageId
            }
            aria-invalid={mutation.state === "error" || undefined}
            value={draft}
            onValueChange={onDraftChange}
            onPrimaryAction={onSubmit}
            disabled={mutation.state === "pending"}
            rows={4}
            placeholder="Record the human decision in Markdown"
            className="w-full resize-y rounded-sm border border-solid border-border-default bg-bg-surface px-sm py-sm font-body text-[0.84rem] text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-1px]"
          />
          <Button
            size="touch"
            variant="primary"
            loading={mutation.state === "pending"}
            disabled={draft.trim().length === 0}
            layoutClassName="justify-self-end max-768:w-full"
            aria-label={`Record answer for ${question.handle}`}
            onClick={onSubmit}
          >
            {mutation.state === "pending" ? "Recording…" : "Record answer"}
          </Button>
        </div>
      ) : (
        <CapabilityNotice
          presentation={question.presentation}
          projectName={projectName}
          slug={slug}
        />
      )}
      <MutationMessage mutation={mutation} id={messageId} />
    </RecordShell>
  );
}

function AssumptionCard({
  assumption,
  projectName,
  slug,
  revision,
  elementHandlesById,
  blocksSignoff,
  choice,
  onChoiceChange,
  mutation,
  historyReason,
  importedAt,
  onNavigateLineage,
  onSubmit,
}: {
  assumption: SpecAssumptionView;
  projectName: string;
  slug: string;
  revision: number;
  elementHandlesById: ReadonlyMap<string, string>;
  blocksSignoff: boolean;
  choice: AssumptionChoice | null;
  onChoiceChange(value: AssumptionChoice): void;
  mutation: MutationState;
  historyReason?: string;
  importedAt: string | null;
  onNavigateLineage(
    event: MouseEvent<HTMLAnchorElement>,
    sourceHandle: string,
    targetHandle: string,
  ): void;
  onSubmit(): void;
}): React.JSX.Element {
  const messageId = useId();
  const capability = assumption.presentation.humanCapability;
  const canDispose = capability?.kind === "dispose" && capability.allowed;
  const citationHandles = useMemo(
    () => [
      ...new Set(
        assumption.currentDraftCitations?.citations.map(
          (citation) => citation.elementHandle ?? "unknown element",
        ) ?? [],
      ),
    ],
    [assumption.currentDraftCitations],
  );
  const action = choice === null ? null : choicePresentation[choice];

  return (
    <RecordShell
      handle={assumption.handle}
      kind="assumption"
      status={{
        ...assumptionStatus[assumption.disposition],
        label:
          settledAtImport(assumption.disposedAt, importedAt) &&
          assumption.disposition !== "proposed"
            ? `${assumptionStatus[assumption.disposition].label} at import`
            : assumptionStatus[assumption.disposition].label,
      }}
      attachment={
        <Attachment
          elementId={assumption.elementId}
          elementHandlesById={elementHandlesById}
        />
      }
      blocksSignoff={blocksSignoff}
      projectName={projectName}
      slug={slug}
      revision={revision}
      name={assumption.text}
    >
      <RecordAttribution
        creationAction="Proposed by"
        creator={assumption.proposedBy}
        createdAt={assumption.createdAt}
        lastMutation={assumption.presentation.lastMutation}
      />
      <div className="mt-sm min-w-0 text-[0.875rem] leading-relaxed text-text-primary">
        <CompactMarkdown content={assumption.text} />
      </div>
      {historyReason !== undefined ? (
        <p className="mt-sm mb-0 rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm text-[0.8rem] leading-relaxed text-text-secondary">
          <span className="font-mono text-[0.68rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
            Reason
          </span>{" "}
          {historyReason}
        </p>
      ) : null}
      <div className="mt-sm grid gap-xs font-mono text-[0.7rem] text-text-secondary">
        <div className="flex flex-wrap items-center gap-xs">
          <span className="font-semibold text-text-tertiary uppercase">
            Citations
          </span>
          {citationHandles.length === 0 ? (
            <span>Not cited by the current draft</span>
          ) : (
            citationHandles.map((handle) => (
              <a
                key={handle}
                href={specElementHref(projectName, slug, handle)}
                className="inline-flex min-h-[44px] items-center text-cyan-dim underline-offset-2 hover:text-cyan hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
              >
                Cited by {handle}
              </a>
            ))
          )}
        </div>
        {assumption.supersedesHandle !== null ? (
          <a
            href={specElementHref(
              projectName,
              slug,
              assumption.supersedesHandle,
            )}
            onClick={(event) => {
              const targetHandle = assumption.supersedesHandle;
              if (targetHandle === null) return;
              onNavigateLineage(event, assumption.handle, targetHandle);
            }}
            className="inline-flex min-h-[44px] w-fit items-center text-cyan-dim underline-offset-2 hover:text-cyan hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Supersedes {assumption.supersedesHandle}
          </a>
        ) : null}
        {assumption.supersededByHandle !== null ? (
          <a
            href={specElementHref(
              projectName,
              slug,
              assumption.supersededByHandle,
            )}
            onClick={(event) => {
              const targetHandle = assumption.supersededByHandle;
              if (targetHandle === null) return;
              onNavigateLineage(event, assumption.handle, targetHandle);
            }}
            className="inline-flex min-h-[44px] w-fit items-center text-cyan-dim underline-offset-2 hover:text-cyan hover:underline focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-2"
          >
            Superseded by {assumption.supersededByHandle}
          </a>
        ) : null}
      </div>
      {blocksSignoff ? (
        <p className="mt-sm mb-0 text-[0.8rem] leading-relaxed text-red">
          Open an amendment and supersede this premise before requesting
          sign-off.
        </p>
      ) : null}
      {canDispose ? (
        <div className="mt-md grid gap-md">
          <fieldset className="m-0 border-0 p-0">
            <legend className="mb-sm font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
              Disposition
            </legend>
            <div className="[&_[role=radiogroup]]:grid-cols-3 max-768:[&_[role=radiogroup]]:grid-cols-1">
              <RadioGroup
                aria-label={`Disposition for ${assumption.handle}`}
                value={choice ?? ""}
                onValueChange={(value) =>
                  onChoiceChange(value as AssumptionChoice)
                }
                disabled={mutation.state === "pending"}
              >
                {(
                  Object.entries(choicePresentation) as [
                    AssumptionChoice,
                    (typeof choicePresentation)[AssumptionChoice],
                  ][]
                ).map(([value, item]) => (
                  <div
                    key={value}
                    className="max-768:relative max-768:min-h-[44px] max-768:[&_label]:absolute max-768:[&_label]:inset-0 max-768:[&_label]:flex max-768:[&_label]:items-center max-768:[&_label]:pl-[24px]"
                  >
                    <RadioGroupOption value={value} label={item.option} />
                  </div>
                ))}
              </RadioGroup>
            </div>
          </fieldset>
          <Button
            size="touch"
            variant={action?.variant ?? "default"}
            loading={mutation.state === "pending"}
            disabled={choice === null}
            layoutClassName="justify-self-end max-768:w-full"
            aria-label={
              action === null
                ? `Record decision for ${assumption.handle}`
                : `${action.action} for ${assumption.handle}`
            }
            onClick={onSubmit}
          >
            {mutation.state === "pending"
              ? "Recording…"
              : (action?.action ?? "Record decision")}
          </Button>
        </div>
      ) : (
        <CapabilityNotice
          presentation={assumption.presentation}
          projectName={projectName}
          slug={slug}
        />
      )}
      <MutationMessage mutation={mutation} id={messageId} />
    </RecordShell>
  );
}

function RegisterPanel({
  title,
  activeCount,
  children,
}: {
  title: string;
  activeCount: number;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section
      aria-label={title}
      className="min-w-0 rounded-lg border border-solid border-border-subtle bg-bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-sm border-x-0 border-t-0 border-b border-solid border-border-dim px-md py-sm">
        <h2 className="m-0 font-display text-[0.9rem] font-bold text-text-primary">
          {title}
        </h2>
        <StatusChip tone={activeCount > 0 ? "amber" : "neutral"}>
          {activeCount} {title === "Questions" ? "open" : "proposed"}
        </StatusChip>
      </div>
      <div className="grid min-w-0 gap-sm p-md">{children}</div>
    </section>
  );
}

export default function SpecAttentionRegisterPrototype({
  projectName,
  slug,
  revision,
  phase,
  questions,
  assumptions,
  history,
  elementHandlesById,
  blockingAssumptionIds = [],
  historyReasonsById = {},
  importedAt = null,
  showIntro = true,
  initiallyOpenHistory = false,
  targetHandle = null,
  initialAnswerDrafts = {},
  initialDispositionChoices = {},
  onAnswerQuestion = async () => undefined,
  onDisposeAssumption = async () => undefined,
}: SpecAttentionRegisterPrototypeProps): React.JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(
    initiallyOpenHistory ||
      history.some(({ record }) => record.handle === targetHandle),
  );
  const [answerDrafts, setAnswerDrafts] = useState<Record<string, string>>(
    () => ({
      ...initialAnswerDrafts,
    }),
  );
  const [choices, setChoices] = useState<Record<string, AssumptionChoice>>(
    () => ({
      ...initialDispositionChoices,
    }),
  );
  const [mutations, setMutations] = useState<Record<string, MutationState>>({});
  const [requestedTargetHandle, setRequestedTargetHandle] =
    useState(targetHandle);
  const focusedTargetRef = useRef<string | null>(null);

  useEffect(() => {
    setRequestedTargetHandle(targetHandle);
    focusedTargetRef.current = null;
  }, [targetHandle]);

  useEffect(() => {
    if (
      requestedTargetHandle === null ||
      focusedTargetRef.current === requestedTargetHandle
    )
      return;
    const historicalTarget = history.some(
      ({ record }) => record.handle === requestedTargetHandle,
    );
    if (historicalTarget && !historyOpen) {
      setHistoryOpen(true);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = document.getElementById(requestedTargetHandle);
      if (target === null) return;
      target.focus();
      focusedTargetRef.current = requestedTargetHandle;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [history, historyOpen, requestedTargetHandle]);

  function navigateLineage(
    event: MouseEvent<HTMLAnchorElement>,
    sourceHandle: string,
    nextHandle: string,
  ): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    const targetState = history.some(
      ({ record }) => record.handle === nextHandle,
    )
      ? "history"
      : questions.some(({ handle }) => handle === nextHandle) ||
          assumptions.some(({ handle }) => handle === nextHandle)
        ? "current"
        : null;
    if (targetState === null) return;
    event.preventDefault();
    const href = specElementHref(projectName, slug, nextHandle);
    if (`${window.location.pathname}${window.location.search}` !== href) {
      window.history.pushState({}, "", href);
    }
    focusedTargetRef.current = null;
    setRequestedTargetHandle(nextHandle);
    if (targetState === "history") setHistoryOpen(true);
    logger.info("spec_studio.attention.lineage_navigated", {
      projectName,
      slug,
      sourceHandle,
      targetHandle: nextHandle,
      targetState,
    });
  }

  function mutationFor(id: string): MutationState {
    return mutations[id] ?? { state: "idle" };
  }

  async function answer(question: SpecQuestionView): Promise<void> {
    const answerText = (answerDrafts[question.id] ?? "").trim();
    if (answerText.length === 0 || mutationFor(question.id).state === "pending")
      return;
    setMutations((current) => ({
      ...current,
      [question.id]: { state: "pending" },
    }));
    try {
      await onAnswerQuestion({
        questionId: question.id,
        recordVersion: question.recordVersion,
        answer: answerText,
      });
      setMutations((current) => ({
        ...current,
        [question.id]: { state: "success", message: "Answer recorded" },
      }));
      document.getElementById(question.handle)?.focus();
    } catch (error) {
      setMutations((current) => ({
        ...current,
        [question.id]: {
          state: "error",
          message:
            error instanceof Error ? error.message : "Couldn't record answer.",
        },
      }));
    }
  }

  async function dispose(assumption: SpecAssumptionView): Promise<void> {
    const disposition = choices[assumption.id];
    if (
      disposition === undefined ||
      mutationFor(assumption.id).state === "pending"
    )
      return;
    setMutations((current) => ({
      ...current,
      [assumption.id]: { state: "pending" },
    }));
    try {
      await onDisposeAssumption({
        assumptionId: assumption.id,
        recordVersion: assumption.recordVersion,
        ...(assumption.currentDraftCitations === null
          ? {}
          : {
              citationVersion: assumption.currentDraftCitations.citationVersion,
            }),
        disposition,
      });
      setMutations((current) => ({
        ...current,
        [assumption.id]: { state: "success", message: "Decision recorded" },
      }));
      document.getElementById(assumption.handle)?.focus();
    } catch (error) {
      setMutations((current) => ({
        ...current,
        [assumption.id]: {
          state: "error",
          message:
            error instanceof Error
              ? error.message
              : "Couldn't record decision.",
        },
      }));
    }
  }

  const openQuestions = questions.filter(
    ({ status }) => status === "open",
  ).length;
  const proposedAssumptions = assumptions.filter(
    ({ disposition }) => disposition === "proposed",
  ).length;
  const requirementsActive =
    phase.authoringStage === "requirements" &&
    (phase.primary === "draft" ||
      phase.primary === "in_review" ||
      phase.authoringFacet === "draft" ||
      phase.authoringFacet === "in_review");

  return (
    <section
      {...(showIntro
        ? { "aria-labelledby": "attention-register-heading" }
        : { "aria-label": "Questions & assumptions" })}
      className="grid min-w-0 gap-lg"
    >
      {showIntro || requirementsActive ? (
        <header>
          {showIntro ? (
            <>
              <h1
                id="attention-register-heading"
                className="m-0 font-display text-xl font-bold text-text-primary"
              >
                Questions &amp; Assumptions
              </h1>
              <p className="mt-xs mb-0 text-[0.86rem] leading-relaxed text-text-secondary">
                Resolve requirement-stage unknowns and premises.
              </p>
            </>
          ) : null}
          {requirementsActive ? (
            <div
              className={cn(
                "flex flex-wrap items-center gap-sm rounded-md border border-solid border-amber-dim bg-amber-glow px-md py-sm",
                showIntro && "mt-sm",
              )}
            >
              <StatusChip tone="amber">Requirements active</StatusChip>
              <span className="font-mono text-[0.7rem] text-amber">
                Design remains locked until the requirements stage is settled.
              </span>
            </div>
          ) : null}
        </header>
      ) : null}

      <div className="grid min-w-0 grid-cols-2 items-start gap-md max-768:grid-cols-1">
        <RegisterPanel title="Questions" activeCount={openQuestions}>
          {questions.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.7rem] text-text-tertiary">
              No current questions.
            </p>
          ) : (
            questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                projectName={projectName}
                slug={slug}
                revision={revision}
                elementHandlesById={elementHandlesById}
                draft={answerDrafts[question.id] ?? ""}
                onDraftChange={(value) =>
                  setAnswerDrafts((current) => ({
                    ...current,
                    [question.id]: value,
                  }))
                }
                mutation={mutationFor(question.id)}
                importedAt={importedAt}
                onSubmit={() => void answer(question)}
              />
            ))
          )}
        </RegisterPanel>

        <RegisterPanel title="Assumptions" activeCount={proposedAssumptions}>
          {assumptions.length === 0 ? (
            <p className="m-0 rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.7rem] text-text-tertiary">
              No current assumptions.
            </p>
          ) : (
            assumptions.map((assumption) => (
              <AssumptionCard
                key={assumption.id}
                assumption={assumption}
                projectName={projectName}
                slug={slug}
                revision={revision}
                elementHandlesById={elementHandlesById}
                blocksSignoff={blockingAssumptionIds.includes(assumption.id)}
                choice={choices[assumption.id] ?? null}
                onChoiceChange={(value) =>
                  setChoices((current) => ({
                    ...current,
                    [assumption.id]: value,
                  }))
                }
                mutation={mutationFor(assumption.id)}
                importedAt={importedAt}
                onNavigateLineage={navigateLineage}
                onSubmit={() => void dispose(assumption)}
              />
            ))
          )}
        </RegisterPanel>
      </div>

      {history.length === 0 ? (
        <p className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase">
          Record history · 0
        </p>
      ) : (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger layoutClassName="w-full max-768:min-h-[44px]">
            Record history · {history.length}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-sm grid grid-cols-2 gap-md max-768:grid-cols-1">
              {history.map((entry) =>
                entry.kind === "question" ? (
                  <QuestionCard
                    key={entry.record.id}
                    question={entry.record}
                    projectName={projectName}
                    slug={slug}
                    revision={revision}
                    elementHandlesById={elementHandlesById}
                    draft=""
                    onDraftChange={() => undefined}
                    mutation={{ state: "idle" }}
                    historyReason={historyReasonsById[entry.record.id]}
                    importedAt={importedAt}
                    onSubmit={() => undefined}
                  />
                ) : (
                  <AssumptionCard
                    key={entry.record.id}
                    assumption={entry.record}
                    projectName={projectName}
                    slug={slug}
                    revision={revision}
                    elementHandlesById={elementHandlesById}
                    blocksSignoff={false}
                    choice={null}
                    onChoiceChange={() => undefined}
                    mutation={{ state: "idle" }}
                    historyReason={historyReasonsById[entry.record.id]}
                    importedAt={importedAt}
                    onNavigateLineage={navigateLineage}
                    onSubmit={() => undefined}
                  />
                ),
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </section>
  );
}
