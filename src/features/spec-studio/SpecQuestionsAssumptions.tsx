"use client";

import { useState } from "react";

import { CopyReferenceControl } from "@/components/references/SpecRefChips";
import { Button } from "@/components/ui/Button";
import { FormGroup, FormInput, FormLabel } from "@/components/ui/FormField";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/Select";
import { StatusChip, type StatusChipTone } from "@/components/ui/StatusChip";
import { createClientLogger } from "@/lib/logging/client-logger";
import { buildSpecReadCommand } from "@/lib/prompt-editor/spec-reference-contract";
import { useSpecActionMutation } from "@/lib/specs/mutations";
import {
  specAssumptionViewSchema,
  specQuestionViewSchema,
  type SpecAssumptionView,
  type SpecDetailView,
  type SpecQuestionView,
} from "@/lib/specs/queries";
import type {
  ActorProvenance,
  SpecAssumptionDisposition,
} from "@/lib/specs/schemas";

const logger = createClientLogger("spec-studio-questions");

export interface AnswerQuestionPanelInput {
  questionId: string;
  answer: string;
}

export type AssumptionDispositionChoice = Exclude<
  SpecAssumptionDisposition,
  "proposed"
>;

export interface DisposeAssumptionPanelInput {
  assumptionId: string;
  disposition: AssumptionDispositionChoice;
}

type QaPendingAction = "answer-question" | "dispose-assumption" | null;

const questionStatusPresentation: Record<
  SpecQuestionView["status"],
  { label: string; tone: StatusChipTone }
> = {
  open: { label: "Open", tone: "amber" },
  answered: { label: "Answered", tone: "green" },
};

const dispositionPresentation: Record<
  SpecAssumptionDisposition,
  { label: string; tone: StatusChipTone }
> = {
  proposed: { label: "Proposed", tone: "amber" },
  confirmed: { label: "Confirmed", tone: "green" },
  rejected: { label: "Rejected", tone: "red" },
  deferred: { label: "Deferred", tone: "neutral" },
};

function provenanceLabel(provenance: ActorProvenance | null): string | null {
  if (provenance === null) return null;
  return provenance.kind === "agent" ? "Agent" : "Operator";
}

export function SpecQuestionsAssumptions({
  questions,
  assumptions,
  projectName,
  slug,
  revision,
  elementHandlesById,
  pendingAction,
  error,
  onAnswerQuestion,
  onDisposeAssumption,
}: {
  questions: SpecQuestionView[];
  assumptions: SpecAssumptionView[];
  projectName: string;
  slug: string;
  revision: number;
  elementHandlesById: ReadonlyMap<string, string>;
  pendingAction: QaPendingAction;
  error: string | null;
  onAnswerQuestion(input: AnswerQuestionPanelInput): void;
  onDisposeAssumption(input: DisposeAssumptionPanelInput): void;
}): React.JSX.Element {
  return (
    <div className="grid gap-lg">
      {error !== null && (
        <div
          role="alert"
          className="rounded-lg border border-solid border-red-dim bg-red-glow p-md font-mono text-[0.72rem] text-red"
        >
          {error}
        </div>
      )}

      <section
        aria-label="Questions"
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface"
      >
        <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
          <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
            Questions
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            Open questions block ambiguity from silently becoming scope.
          </p>
        </div>
        <div className="grid gap-sm p-md">
          {questions.length === 0 ? (
            <span className="rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.68rem] text-text-tertiary">
              No questions recorded for this spec.
            </span>
          ) : (
            questions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question}
                projectName={projectName}
                slug={slug}
                revision={revision}
                elementHandlesById={elementHandlesById}
                pendingAction={pendingAction}
                onAnswerQuestion={onAnswerQuestion}
              />
            ))
          )}
        </div>
      </section>

      <section
        aria-label="Assumptions"
        className="rounded-lg border border-solid border-border-subtle bg-bg-surface"
      >
        <div className="border-x-0 border-t-0 border-b border-solid border-border-dim px-lg py-md">
          <h2 className="m-0 font-display text-[0.92rem] font-bold text-text-primary">
            Assumptions
          </h2>
          <p className="mt-xs mb-0 font-mono text-[0.7rem] text-text-tertiary">
            Agents propose; only the operator confirms, rejects, or defers.
          </p>
        </div>
        <div className="grid gap-sm p-md">
          {assumptions.length === 0 ? (
            <span className="rounded-md border border-dashed border-border-dim px-md py-sm font-mono text-[0.68rem] text-text-tertiary">
              No assumptions proposed for this spec.
            </span>
          ) : (
            assumptions.map((assumption) => (
              <AssumptionCard
                key={assumption.id}
                assumption={assumption}
                projectName={projectName}
                slug={slug}
                revision={revision}
                elementHandlesById={elementHandlesById}
                pendingAction={pendingAction}
                onDisposeAssumption={onDisposeAssumption}
              />
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function AttachmentChip({
  elementId,
  elementHandlesById,
}: {
  elementId: string | null;
  elementHandlesById: ReadonlyMap<string, string>;
}): React.JSX.Element {
  if (elementId === null) {
    // Spec-level records are not citations: a rejected spec-level assumption
    // never blocks sign-off (rule 9.8 applies to attached assumptions only).
    return <StatusChip tone="neutral">Spec-level</StatusChip>;
  }
  const handle = elementHandlesById.get(elementId);
  return (
    <StatusChip tone="cyan">
      {handle === undefined ? "Attached" : `Attached to ${handle}`}
    </StatusChip>
  );
}

function QuestionCard({
  question,
  projectName,
  slug,
  revision,
  elementHandlesById,
  pendingAction,
  onAnswerQuestion,
}: {
  question: SpecQuestionView;
  projectName: string;
  slug: string;
  revision: number;
  elementHandlesById: ReadonlyMap<string, string>;
  pendingAction: QaPendingAction;
  onAnswerQuestion(input: AnswerQuestionPanelInput): void;
}): React.JSX.Element {
  const [answer, setAnswer] = useState("");
  const status = questionStatusPresentation[question.status];
  const askedBy = provenanceLabel(question.provenance);

  return (
    <article
      id={question.handle}
      data-spec-element={question.handle}
      tabIndex={-1}
      className="rounded-md border border-solid border-border-dim bg-bg-base p-md focus-visible:[outline:2px_solid_var(--color-cyan)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-sm">
            <span className="font-mono text-[0.72rem] font-bold text-cyan">
              {question.handle}
            </span>
            <StatusChip tone={status.tone}>{status.label}</StatusChip>
            <AttachmentChip
              elementId={question.elementId}
              elementHandlesById={elementHandlesById}
            />
            {askedBy !== null && (
              <span className="font-mono text-[0.66rem] tracking-[0.06em] text-text-tertiary uppercase">
                Asked by {askedBy}
              </span>
            )}
          </div>
          <p className="mt-xs mb-0 text-[0.76rem] leading-relaxed text-text-secondary">
            {question.text}
          </p>
        </div>
        <CopyReferenceControl
          referenceType="question"
          attrs={{
            projectName,
            slug,
            handle: question.handle,
            name: question.text,
            revision: String(revision),
            readCommand: buildSpecReadCommand(
              projectName,
              slug,
              question.handle,
            ),
          }}
        />
      </div>

      {question.status === "answered" ? (
        <div className="mt-md rounded-md border border-solid border-border-dim bg-bg-surface px-md py-sm">
          <span className="font-mono text-[0.64rem] tracking-[0.06em] text-text-tertiary uppercase">
            Answer
          </span>
          <p className="mt-xs mb-0 text-[0.76rem] leading-relaxed text-text-primary">
            {question.answer}
          </p>
        </div>
      ) : (
        <div className="mt-md grid grid-cols-[minmax(0,1fr)_auto] items-end gap-sm max-768:grid-cols-1">
          <FormGroup layoutClassName="mb-0">
            <FormLabel htmlFor={`question-answer-${question.id}`}>
              Answer
            </FormLabel>
            <FormInput
              id={`question-answer-${question.id}`}
              aria-label={`Answer for ${question.handle}`}
              value={answer}
              onChange={(event) => setAnswer(event.currentTarget.value)}
              placeholder="Record the human decision"
            />
          </FormGroup>
          <Button
            size="sm"
            loading={pendingAction === "answer-question"}
            disabled={answer.trim().length === 0}
            aria-label={`Record answer for ${question.handle}`}
            onClick={() =>
              onAnswerQuestion({
                questionId: question.id,
                answer: answer.trim(),
              })
            }
          >
            Record answer
          </Button>
        </div>
      )}
    </article>
  );
}

function AssumptionCard({
  assumption,
  projectName,
  slug,
  revision,
  elementHandlesById,
  pendingAction,
  onDisposeAssumption,
}: {
  assumption: SpecAssumptionView;
  projectName: string;
  slug: string;
  revision: number;
  elementHandlesById: ReadonlyMap<string, string>;
  pendingAction: QaPendingAction;
  onDisposeAssumption(input: DisposeAssumptionPanelInput): void;
}): React.JSX.Element {
  const [selectedDisposition, setSelectedDisposition] = useState<
    "" | AssumptionDispositionChoice
  >(assumption.disposition === "proposed" ? "" : assumption.disposition);
  const disposition = dispositionPresentation[assumption.disposition];
  const proposedBy = provenanceLabel(assumption.proposedBy);
  const canSave =
    selectedDisposition !== "" &&
    selectedDisposition !== assumption.disposition;

  return (
    <article
      id={assumption.handle}
      data-spec-element={assumption.handle}
      tabIndex={-1}
      className="rounded-md border border-solid border-border-dim bg-bg-base p-md focus-visible:[outline:2px_solid_var(--color-cyan)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-sm">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-sm">
            <span className="font-mono text-[0.72rem] font-bold text-cyan">
              {assumption.handle}
            </span>
            <StatusChip tone={disposition.tone}>{disposition.label}</StatusChip>
            <AttachmentChip
              elementId={assumption.elementId}
              elementHandlesById={elementHandlesById}
            />
            {proposedBy !== null && (
              <span className="font-mono text-[0.66rem] tracking-[0.06em] text-text-tertiary uppercase">
                Proposed by {proposedBy}
              </span>
            )}
          </div>
          <p className="mt-xs mb-0 text-[0.76rem] leading-relaxed text-text-secondary">
            {assumption.text}
          </p>
        </div>
        <CopyReferenceControl
          referenceType="assumption"
          attrs={{
            projectName,
            slug,
            handle: assumption.handle,
            name: assumption.text,
            revision: String(revision),
            readCommand: buildSpecReadCommand(
              projectName,
              slug,
              assumption.handle,
            ),
          }}
        />
      </div>

      <div className="mt-md grid grid-cols-[minmax(0,1fr)_auto] items-end gap-sm max-768:grid-cols-1">
        <FormGroup layoutClassName="mb-0">
          <FormLabel>Disposition</FormLabel>
          <Select
            value={selectedDisposition}
            onValueChange={(value) =>
              setSelectedDisposition(value as AssumptionDispositionChoice)
            }
          >
            <SelectTrigger
              aria-label={`Disposition for ${assumption.handle}`}
              layoutClassName="w-full"
            >
              <SelectValue placeholder="Awaiting human disposition" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="confirmed">Confirmed</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
              <SelectItem value="deferred">Deferred</SelectItem>
            </SelectContent>
          </Select>
        </FormGroup>
        <Button
          size="sm"
          loading={pendingAction === "dispose-assumption"}
          disabled={!canSave}
          aria-label={`Save disposition for ${assumption.handle}`}
          onClick={() => {
            if (selectedDisposition === "") return;
            onDisposeAssumption({
              assumptionId: assumption.id,
              disposition: selectedDisposition,
            });
          }}
        >
          Save disposition
        </Button>
      </div>
    </article>
  );
}

function elementHandleIndex(detail: SpecDetailView): Map<string, string> {
  const snapshot = detail.currentRevision ?? detail.currentApprovedRevision;
  const handles = new Map<string, string>();
  if (snapshot === null) return handles;
  for (const entry of snapshot.elements) {
    const number = entry.element.number;
    if (number === null) continue;
    switch (entry.version.payload.kind) {
      case "requirement":
        handles.set(entry.element.id, `R${number}`);
        break;
      case "decision":
        handles.set(entry.element.id, `D${number}`);
        break;
      case "task":
        handles.set(entry.element.id, `T${number}`);
        break;
      default:
        break;
    }
  }
  // Criterion handles derive from the parent requirement's number, so they
  // resolve in a second pass once every requirement is indexed.
  for (const entry of snapshot.elements) {
    if (
      entry.version.payload.kind !== "criterion" ||
      entry.element.number === null ||
      entry.element.parentElementId === null
    ) {
      continue;
    }
    const parent = handles.get(entry.element.parentElementId);
    if (parent === undefined) continue;
    handles.set(entry.element.id, `${parent}.${entry.element.number}`);
  }
  return handles;
}

export default function SpecQuestionsAssumptionsPanel({
  detail,
  projectName,
}: {
  detail: SpecDetailView;
  projectName: string;
}): React.JSX.Element {
  const [actionFailure, setActionFailure] = useState<{
    action: string;
    message: string;
  } | null>(null);
  const answerQuestion = useSpecActionMutation<
    AnswerQuestionPanelInput,
    SpecQuestionView
  >(projectName, detail.spec.slug, "answer-question", specQuestionViewSchema, {
    specId: detail.spec.id,
    eventTypes: ["spec-attention-changed"],
  });
  const disposeAssumption = useSpecActionMutation<
    DisposeAssumptionPanelInput,
    SpecAssumptionView
  >(
    projectName,
    detail.spec.slug,
    "dispose-assumption",
    specAssumptionViewSchema,
    { specId: detail.spec.id, eventTypes: ["spec-attention-changed"] },
  );

  function mutationCallbacks(action: string) {
    return {
      onSuccess: () => {
        setActionFailure(null);
        logger.info("spec_studio.qa_action.completed", {
          action,
          specId: detail.spec.id,
        });
      },
      onError: (mutationError: Error) => {
        setActionFailure({ action, message: mutationError.message });
        logger.warn("spec_studio.qa_action.failed", {
          action,
          specId: detail.spec.id,
          error: mutationError.message,
        });
      },
    };
  }

  const pendingAction: QaPendingAction = answerQuestion.isPending
    ? "answer-question"
    : disposeAssumption.isPending
      ? "dispose-assumption"
      : null;
  const revision = Math.max(
    1,
    ...detail.revisions.map((revision) => revision.number),
  );

  return (
    <SpecQuestionsAssumptions
      questions={detail.questions}
      assumptions={detail.assumptions}
      projectName={projectName}
      slug={detail.spec.slug}
      revision={revision}
      elementHandlesById={elementHandleIndex(detail)}
      pendingAction={pendingAction}
      error={actionFailure?.message ?? null}
      onAnswerQuestion={(input) =>
        answerQuestion.mutate(input, mutationCallbacks("answer-question"))
      }
      onDisposeAssumption={(input) =>
        disposeAssumption.mutate(input, mutationCallbacks("dispose-assumption"))
      }
    />
  );
}
