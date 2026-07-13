/**
 * Pure, DOM-free logic for the AskUserQuestion panel.
 *
 * Extracted from the component so the answer-draft derivations (selection
 * toggling, progress/required gating, suggested defaults, and the submit
 * payload transform) can be unit-tested directly without rendering or mocking.
 * Question context prose renders through the canonical `CompactMarkdown`
 * adapter, so no Markdown parsing lives here.
 */

import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";

/** Marks the "Something else" free-text choice inside a draft's `selected`. */
export const OTHER_SENTINEL = "__other__";

/** Per-question working draft held in component state while the user answers. */
export interface AnswerDraft {
  /** Chosen option labels; includes {@link OTHER_SENTINEL} while "Something else" is picked. */
  selected: string[];
  note: string;
  noteOpen: boolean;
  otherText: string;
  skipped: boolean;
}

export type DraftMap = Record<string, AnswerDraft>;

export type QuestionStatus =
  | "answered"
  | "skipped"
  | "suggested"
  | "required-empty"
  | "";

export interface Progress {
  answeredCount: number;
  total: number;
  requiredRemaining: number;
  canSubmit: boolean;
  percent: number;
  hasSuggestions: boolean;
}

/** Stable per-question key: the explicit id, or the index as a fallback. */
export function questionKey(q: AskQuestionItem, index: number): string {
  return q.id ?? String(index);
}

function emptyDraft(): AnswerDraft {
  return {
    selected: [],
    note: "",
    noteOpen: false,
    otherText: "",
    skipped: false,
  };
}

export function initDraftMap(questions: AskQuestionItem[]): DraftMap {
  const map: DraftMap = {};
  questions.forEach((q, i) => {
    map[questionKey(q, i)] = emptyDraft();
  });
  return map;
}

export function toggleOption(
  draft: AnswerDraft,
  label: string,
  multiSelect: boolean,
): AnswerDraft {
  let selected: string[];
  if (multiSelect) {
    selected = draft.selected.includes(label)
      ? draft.selected.filter((l) => l !== label)
      : [...draft.selected, label];
  } else {
    selected = draft.selected.includes(label) ? [] : [label];
  }
  return { ...draft, selected, skipped: false };
}

export function isAnswered(draft: AnswerDraft | undefined): boolean {
  if (!draft) return false;
  const hasOther =
    draft.selected.includes(OTHER_SENTINEL) &&
    draft.otherText.trim().length > 0;
  return draft.selected.some((l) => l !== OTHER_SENTINEL) || hasOther;
}

export function isResolved(draft: AnswerDraft | undefined): boolean {
  return isAnswered(draft) || draft?.skipped === true;
}

export function computeProgress(
  questions: AskQuestionItem[],
  drafts: DraftMap,
): Progress {
  const draftFor = (q: AskQuestionItem, i: number) => drafts[questionKey(q, i)];
  const total = questions.length;
  const answeredCount = questions.filter((q, i) =>
    isAnswered(draftFor(q, i)),
  ).length;
  const requiredRemaining = questions.filter(
    (q, i) => q.required && !isAnswered(draftFor(q, i)),
  ).length;
  const resolvedCount = questions.filter((q, i) =>
    isResolved(draftFor(q, i)),
  ).length;
  return {
    answeredCount,
    total,
    requiredRemaining,
    canSubmit: requiredRemaining === 0,
    percent: total === 0 ? 0 : Math.round((resolvedCount / total) * 100),
    hasSuggestions: questions.some((q) => q.options.some((o) => o.recommended)),
  };
}

export function statusOfQuestion(
  q: AskQuestionItem,
  draft: AnswerDraft | undefined,
): QuestionStatus {
  if (isAnswered(draft)) return "answered";
  if (draft?.skipped) return "skipped";
  if (q.options.some((o) => o.recommended)) return "suggested";
  if (q.required) return "required-empty";
  return "";
}

export function summaryOfQuestion(draft: AnswerDraft | undefined): string {
  if (!draft) return "";
  if (draft.skipped && !isAnswered(draft)) return "Skipped";
  const picks = draft.selected.filter((l) => l !== OTHER_SENTINEL);
  if (draft.selected.includes(OTHER_SENTINEL) && draft.otherText.trim()) {
    picks.push(`“${draft.otherText.trim()}”`);
  }
  let summary = picks.join(", ");
  if (draft.note.trim()) summary += summary ? " + note" : "Note only";
  return summary;
}

export function acceptAllSuggested(
  questions: AskQuestionItem[],
  drafts: DraftMap,
): DraftMap {
  const next: DraftMap = { ...drafts };
  questions.forEach((q, i) => {
    const key = questionKey(q, i);
    const recs = q.options.filter((o) => o.recommended).map((o) => o.label);
    if (recs.length === 0) return;
    const base = next[key] ?? emptyDraft();
    next[key] = {
      ...base,
      selected: q.multiSelect ? recs : recs.slice(0, 1),
      skipped: false,
    };
  });
  return next;
}

/**
 * The submit transform. Keys answers by question key (id/index), strips the
 * "Something else" sentinel, appends its verbatim text, normalizes an empty
 * note to null, and marks an answer skipped only when nothing was picked.
 */
export function buildAnswerPayload(
  questions: AskQuestionItem[],
  drafts: DraftMap,
): Record<string, AskQuestionAnswer> {
  const answers: Record<string, AskQuestionAnswer> = {};
  questions.forEach((q, i) => {
    const key = questionKey(q, i);
    const draft = drafts[key] ?? emptyDraft();
    const picks = draft.selected.filter((l) => l !== OTHER_SENTINEL);
    if (draft.selected.includes(OTHER_SENTINEL) && draft.otherText.trim()) {
      picks.push(draft.otherText.trim());
    }
    answers[key] = {
      selected: picks,
      note: draft.note.trim() || null,
      skipped: draft.skipped && picks.length === 0,
      question: q.question,
    };
  });
  return answers;
}
