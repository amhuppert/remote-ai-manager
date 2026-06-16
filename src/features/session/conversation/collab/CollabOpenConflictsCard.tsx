"use client";

import type {
  CollaborationArtifactDisagreement,
  CollaborationUserQuestion,
} from "@/lib/workflows/collaboration/types";
import CollabSeverityCategoryChip from "@/features/session/conversation/collab/CollabSeverityCategoryChip";

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
    <div className="collab-open-conflicts-card-question-meta">
      <span className="collab-open-conflicts-card-question-id">
        {question.id}
      </span>
      {question.relatedDisagreementIds.length > 0 ? (
        <ul
          className="collab-open-conflicts-card-question-link-list"
          aria-label={`Related disagreements for ${question.id}`}
        >
          {question.relatedDisagreementIds.map((id) => {
            const target = lookup.get(id);
            return (
              <li
                key={`${question.id}-link-${id}`}
                className="collab-open-conflicts-card-question-link"
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
      className="collab-open-conflicts-card-disagreements"
      aria-label="Open disagreements"
    >
      <h4 className="collab-open-conflicts-card-disagreements-title">
        Open disagreements
      </h4>
      <ul className="collab-id-list">
        {disagreements.map((d) => (
          <li key={d.id} className="collab-id-list-item">
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
    <header className="collab-open-conflicts-card-header">
      <span className="collab-open-conflicts-card-glyph" aria-hidden="true">
        ?
      </span>
      <span className="collab-open-conflicts-card-title">Awaiting Alex</span>
      <span className="collab-open-conflicts-card-count">
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
        className="collab-open-conflicts-card"
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
            className="collab-open-conflicts-card-questions"
            aria-label="Questions answered by Alex"
          >
            {props.questions.map((q) => {
              const answer = props.submittedAnswers[q.id]?.trim() ?? "";
              return (
                <li className="collab-open-conflicts-card-question" key={q.id}>
                  <QuestionMeta question={q} lookup={lookup} />
                  <p className="collab-open-conflicts-card-question-text">
                    {q.question}
                  </p>
                  {answer.length > 0 ? (
                    <p
                      className="collab-open-conflicts-card-answer"
                      aria-label={`Submitted answer for ${q.id}`}
                    >
                      {answer}
                    </p>
                  ) : (
                    <p
                      className="collab-open-conflicts-card-answer collab-open-conflicts-card-answer-empty"
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
      className="collab-open-conflicts-card"
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
          className="collab-open-conflicts-card-questions"
          aria-label="Questions for Alex"
        >
          {props.questions.map((q) => {
            const value = props.drafts[q.id] ?? "";
            return (
              <li className="collab-open-conflicts-card-question" key={q.id}>
                <QuestionMeta question={q} lookup={lookup} />
                <p className="collab-open-conflicts-card-question-text">
                  {q.question}
                </p>
                {/* a11y label. The conventional "screen reader only" utility
                    class name is also a Tailwind utility; using it here would let
                    the Tailwind integration hide this label, which had no CSS rule
                    and rendered visibly. Kept as a BEM class to preserve that
                    baseline; the visually-hidden treatment is restored when this
                    card migrates to Tailwind. */}
                <label
                  className="collab-open-conflicts-card-answer-label"
                  htmlFor={`collab-answer-${q.id}`}
                >
                  Answer for {q.id}
                </label>
                <textarea
                  id={`collab-answer-${q.id}`}
                  className="collab-open-conflicts-card-textarea"
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
      <div className="collab-open-conflicts-card-actions">
        <button
          type="button"
          className="collab-open-conflicts-card-submit"
          onClick={props.onSubmit}
          disabled={!canSubmit}
        >
          {props.isSubmitting ? "Submitting…" : "Send answers"}
        </button>
      </div>
    </section>
  );
}
