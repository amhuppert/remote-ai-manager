"use client";

import { cn } from "@/lib/ui/cn";
import type {
  CollaborationArtifactDisagreement,
  CollaborationUserQuestion,
} from "@/lib/workflows/collaboration/types";
import CollabSeverityCategoryChip from "@/features/session/conversation/collab/CollabSeverityCategoryChip";
import {
  idList,
  idListItem,
} from "@/features/session/conversation/collab/card-chrome";

const cardClass =
  "flex flex-col gap-md rounded-md border border-solid border-amber-dim border-l-4 border-l-amber bg-bg-raised p-md";
const answerClass =
  "m-0 rounded-sm border-0 border-l-2 border-solid border-l-cyan bg-bg-base p-sm font-mono text-[0.82rem] whitespace-pre-wrap text-text-primary";

interface AwaitingProps {
  mode: "awaiting";
  disagreements: CollaborationArtifactDisagreement[];
  questions: CollaborationUserQuestion[];
  drafts: Record<string, string>;
  onDraftChange: (questionId: string, value: string) => void;
  onSubmit: () => void;
  isSubmitting: boolean;
}

interface AnsweredProps {
  mode: "answered";
  disagreements: CollaborationArtifactDisagreement[];
  questions: CollaborationUserQuestion[];
  submittedAnswers: Record<string, string>;
}

export type CollabOpenConflictsCardProps = AwaitingProps | AnsweredProps;

function disagreementById(
  disagreements: CollaborationArtifactDisagreement[],
): Map<string, CollaborationArtifactDisagreement> {
  const map = new Map<string, CollaborationArtifactDisagreement>();
  for (const d of disagreements) map.set(d.id, d);
  return map;
}

function hasAtLeastOneAnswer(drafts: Record<string, string>): boolean {
  return Object.values(drafts).some((v) => v.trim().length > 0);
}

function QuestionMeta({
  question,
  lookup,
}: {
  question: CollaborationUserQuestion;
  lookup: Map<string, CollaborationArtifactDisagreement>;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-[6px]">
      <span className="font-mono text-[length:var(--font-size-floor)] font-bold tracking-[0.06em] text-text-secondary">
        {question.id}
      </span>
      {question.relatedDisagreementIds.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-wrap items-center gap-[4px] p-0"
          aria-label={`Related disagreements for ${question.id}`}
        >
          {question.relatedDisagreementIds.map((id) => {
            const target = lookup.get(id);
            return (
              <li
                key={`${question.id}-link-${id}`}
                className="rounded-sm border border-solid border-border-subtle bg-bg-base px-[6px] py-[1px] font-mono text-[length:var(--font-size-floor)] text-cyan-dim"
                title={target?.claim ?? id}
              >
                {id}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function DisagreementsList({
  disagreements,
}: {
  disagreements: CollaborationArtifactDisagreement[];
}): React.JSX.Element | null {
  if (disagreements.length === 0) return null;
  return (
    <div
      className="flex flex-col gap-[6px] rounded-sm border border-solid border-border-subtle bg-bg-base p-sm"
      aria-label="Open disagreements"
    >
      <h4 className="m-0 font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
        Open disagreements
      </h4>
      <ul className={idList}>
        {disagreements.map((d) => (
          <li key={d.id} className={idListItem}>
            {d.id}: {d.claim}{" "}
            <CollabSeverityCategoryChip
              severity={d.severity}
              category={d.category}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CardHeader({
  questionCount,
  disagreementCount,
}: {
  questionCount: number;
  disagreementCount: number;
}): React.JSX.Element {
  return (
    <header className="flex items-center gap-sm">
      <span className="text-[1rem] leading-none text-amber" aria-hidden="true">
        ?
      </span>
      <span className="font-display text-[0.95rem] font-bold text-text-primary">
        Awaiting Alex
      </span>
      <span className="ml-auto font-mono text-[0.72rem] text-text-secondary">
        {questionCount} {questionCount === 1 ? "question" : "questions"}
        {" · "}
        {disagreementCount}{" "}
        {disagreementCount === 1 ? "disagreement" : "disagreements"}
      </span>
    </header>
  );
}

export default function CollabOpenConflictsCard(
  props: CollabOpenConflictsCardProps,
): React.JSX.Element {
  const lookup = disagreementById(props.disagreements);

  if (props.mode === "answered") {
    return (
      <section
        className={cardClass}
        data-kind="open_conflicts"
        data-mode="answered"
        aria-label="Open conflicts answered by Alex"
      >
        <CardHeader
          questionCount={props.questions.length}
          disagreementCount={props.disagreements.length}
        />
        <DisagreementsList disagreements={props.disagreements} />
        {props.questions.length > 0 ? (
          <ul
            className="m-0 flex list-none flex-col gap-md p-0"
            aria-label="Questions answered by Alex"
          >
            {props.questions.map((q) => {
              const answer = props.submittedAnswers[q.id]?.trim() ?? "";
              return (
                <li className="flex flex-col gap-[6px]" key={q.id}>
                  <QuestionMeta question={q} lookup={lookup} />
                  <p className="text-[0.85rem] leading-[1.5] text-text-primary">
                    {q.question}
                  </p>
                  {answer.length > 0 ? (
                    <p
                      className={answerClass}
                      aria-label={`Submitted answer for ${q.id}`}
                    >
                      {answer}
                    </p>
                  ) : (
                    <p
                      className={cn(
                        answerClass,
                        "border-l-border-default text-text-secondary italic",
                      )}
                      aria-label={`Submitted answer for ${q.id}`}
                    >
                      No answer
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    );
  }

  const canSubmit = !props.isSubmitting && hasAtLeastOneAnswer(props.drafts);
  return (
    <section
      className={cardClass}
      data-kind="open_conflicts"
      data-mode="awaiting"
      aria-label="Open conflicts awaiting Alex"
    >
      <CardHeader
        questionCount={props.questions.length}
        disagreementCount={props.disagreements.length}
      />
      <DisagreementsList disagreements={props.disagreements} />
      {props.questions.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-col gap-md p-0"
          aria-label="Questions for Alex"
        >
          {props.questions.map((q) => {
            const value = props.drafts[q.id] ?? "";
            return (
              <li className="flex flex-col gap-[6px]" key={q.id}>
                <QuestionMeta question={q} lookup={lookup} />
                <p className="text-[0.85rem] leading-[1.5] text-text-primary">
                  {q.question}
                </p>
                <label className="sr-only" htmlFor={`collab-answer-${q.id}`}>
                  Answer for {q.id}
                </label>
                <textarea
                  id={`collab-answer-${q.id}`}
                  className="min-h-[80px] w-full resize-y rounded-sm border border-solid border-border-default bg-bg-base p-sm font-mono text-[0.82rem] text-text-primary focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-1 max-768:min-h-[100px]"
                  value={value}
                  onChange={(event) =>
                    props.onDraftChange(q.id, event.target.value)
                  }
                  placeholder="Your answer (free-form)…"
                  disabled={props.isSubmitting}
                />
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex justify-end">
        <button
          type="button"
          className="cursor-pointer rounded-sm border border-solid border-cyan bg-cyan px-[16px] py-[8px] font-mono text-[0.78rem] font-semibold text-text-inverse disabled:cursor-not-allowed disabled:opacity-50 max-768:min-h-[var(--touch-target-min)] max-768:w-full"
          onClick={props.onSubmit}
          disabled={!canSubmit}
        >
          {props.isSubmitting ? "Submitting…" : "Send answers"}
        </button>
      </div>
    </section>
  );
}
