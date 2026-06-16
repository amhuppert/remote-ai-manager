"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PlusIcon,
  SearchIcon,
  StarIcon,
} from "@/components/icons";
import {
  OTHER_SENTINEL,
  acceptAllSuggested,
  buildAnswerPayload,
  computeProgress,
  initDraftMap,
  isAnswered,
  parseContext,
  questionKey,
  statusOfQuestion,
  summaryOfQuestion,
  toggleOption,
  type AnswerDraft,
  type ContextBlock,
  type DraftMap,
  type InlineSpan,
  type QuestionStatus,
} from "@/components/ask-question-logic";

interface AskQuestionPanelProps {
  questions: AskQuestionItem[];
  questionId: string;
  /** Active question index — controlled by the store (docked) or peek nav. */
  currentIndex: number;
  onNavigate: (index: number) => void;
  onSubmit: (
    questionId: string,
    answers: Record<string, AskQuestionAnswer>,
  ) => void;
  /** Asking agent; drives the accent color (cyan = claude, violet = codex). */
  agent?: AgentBackendId;
  /** Container-driven: swaps the rail for a chip pager and grows touch targets. */
  compact?: boolean;
}

const EMPTY_DRAFT: AnswerDraft = {
  selected: [],
  note: "",
  noteOpen: false,
  otherText: "",
  skipped: false,
};

function InlineSpans({ spans }: { spans: InlineSpan[] }) {
  return (
    <>
      {spans.map((span, i) => {
        if (span.kind === "code") return <code key={i}>{span.text}</code>;
        if (span.kind === "bold") return <strong key={i}>{span.text}</strong>;
        return <span key={i}>{span.text}</span>;
      })}
    </>
  );
}

function ContextBody({ text }: { text: string }) {
  const blocks: ContextBlock[] = useMemo(() => parseContext(text), [text]);
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === "p" ? (
          <p key={i}>
            <InlineSpans spans={block.spans} />
          </p>
        ) : (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <InlineSpans spans={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

function ContextDisclosure({
  question,
  open,
  onToggle,
}: {
  question: AskQuestionItem;
  open: boolean;
  onToggle: () => void;
}) {
  if (!question.context) return null;
  return (
    <div className={`ask-question-context${open ? " open" : ""}`}>
      <button
        type="button"
        className="ask-question-context-head"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>Context · trade-offs</span>
        <span className="ask-question-context-chev">
          <ChevronRightIcon size={11} />
        </span>
      </button>
      {open && (
        <div className="ask-question-context-body">
          <ContextBody text={question.context} />
        </div>
      )}
    </div>
  );
}

function OptionRow({
  option,
  index,
  multiSelect,
  selected,
  showKbd,
  onToggle,
}: {
  option: AskQuestionItem["options"][number];
  index: number;
  multiSelect: boolean;
  selected: boolean;
  showKbd: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={`ask-question-option${selected ? " selected" : ""}`}
      role={multiSelect ? "checkbox" : "radio"}
      aria-checked={selected}
      tabIndex={0}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span
        className={`ask-question-option-mark ${multiSelect ? "check" : "radio"}`}
        aria-hidden="true"
      >
        {selected &&
          (multiSelect ? (
            <CheckIcon size={12} />
          ) : (
            <span className="ask-question-option-dot" />
          ))}
      </span>
      <span className="ask-question-option-content">
        <span className="ask-question-option-label-row">
          <span className="ask-question-option-label">{option.label}</span>
          {option.recommended && (
            <span className="ask-question-suggested">
              <StarIcon size={9} /> Suggested
            </span>
          )}
        </span>
        {option.description && (
          <span className="ask-question-option-desc">{option.description}</span>
        )}
        {option.tradeoff?.pro && (
          <span className="ask-question-tradeoff">
            <span className="ask-question-tradeoff-tick pro">+</span>
            <span>{option.tradeoff.pro}</span>
          </span>
        )}
        {option.tradeoff?.con && (
          <span className="ask-question-tradeoff">
            <span className="ask-question-tradeoff-tick con">−</span>
            <span>{option.tradeoff.con}</span>
          </span>
        )}
      </span>
      {showKbd && index < 9 && (
        <span className="ask-question-option-kbd">{index + 1}</span>
      )}
    </div>
  );
}

function QuestionCard({
  question,
  index,
  total,
  draft,
  showKbd,
  ctxOpen,
  onCtxToggle,
  onToggleOption,
  onOtherText,
  onNote,
  onNoteToggle,
}: {
  question: AskQuestionItem;
  index: number;
  total: number;
  draft: AnswerDraft;
  showKbd: boolean;
  ctxOpen: boolean;
  onCtxToggle: () => void;
  onToggleOption: (label: string) => void;
  onOtherText: (value: string) => void;
  onNote: (value: string) => void;
  onNoteToggle: () => void;
}) {
  const otherSelected = draft.selected.includes(OTHER_SENTINEL);
  return (
    <div className="ask-question-card">
      <div className="ask-question-card-cat">
        {question.header && (
          <span className="ask-question-card-cat-label">{question.header}</span>
        )}
        {question.required ? (
          <span className="ask-question-tag required">Required</span>
        ) : (
          <span className="ask-question-tag optional">Optional</span>
        )}
        {question.multiSelect && (
          <span className="ask-question-tag multi">Select multiple</span>
        )}
        <span className="ask-question-card-stepnum">
          Q{index + 1} / {total}
        </span>
      </div>
      <div className="ask-question-card-q">{question.question}</div>
      <ContextDisclosure
        question={question}
        open={ctxOpen}
        onToggle={onCtxToggle}
      />
      <div className="ask-question-options">
        {question.options.map((option, i) => (
          <OptionRow
            key={option.label}
            option={option}
            index={i}
            multiSelect={question.multiSelect}
            selected={draft.selected.includes(option.label)}
            showKbd={showKbd}
            onToggle={() => onToggleOption(option.label)}
          />
        ))}
        <div
          className={`ask-question-option${otherSelected ? " selected" : ""}`}
          role={question.multiSelect ? "checkbox" : "radio"}
          aria-checked={otherSelected}
          tabIndex={0}
          onClick={() => onToggleOption(OTHER_SENTINEL)}
          onKeyDown={(e) => {
            // Keys typed in the nested free-text input bubble here; only the
            // option row itself should toggle on Enter/Space.
            if (e.target !== e.currentTarget) return;
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onToggleOption(OTHER_SENTINEL);
            }
          }}
        >
          <span
            className={`ask-question-option-mark ${question.multiSelect ? "check" : "radio"}`}
            aria-hidden="true"
          >
            {otherSelected &&
              (question.multiSelect ? (
                <CheckIcon size={12} />
              ) : (
                <span className="ask-question-option-dot" />
              ))}
          </span>
          <span className="ask-question-option-content">
            <span className="ask-question-option-label-row">
              <span className="ask-question-option-label">Something else…</span>
            </span>
            {otherSelected && (
              <input
                className="ask-question-other-input"
                placeholder="Type your own answer…"
                value={draft.otherText}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onOtherText(e.target.value)}
              />
            )}
          </span>
        </div>
      </div>
      {question.allowNote && (
        <div className="ask-question-note">
          {draft.noteOpen ? (
            <div className="ask-question-note-field">
              <div className="ask-question-note-label">
                Your note{" "}
                <span className="ask-question-note-label-hint">
                  · sent with your selection
                </span>
              </div>
              <textarea
                placeholder="e.g. 'Go with SQLite, but gate it behind a flag for the first release.'"
                value={draft.note}
                autoFocus
                onChange={(e) => onNote(e.target.value)}
              />
            </div>
          ) : (
            <button
              type="button"
              className="ask-question-note-toggle"
              onClick={onNoteToggle}
            >
              <span className="ask-question-note-plus">
                <PlusIcon size={11} />
              </span>{" "}
              Add a note to clarify your answer (optional)
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function RailItem({
  question,
  index,
  active,
  status,
  summary,
  onClick,
}: {
  question: AskQuestionItem;
  index: number;
  active: boolean;
  status: QuestionStatus;
  summary: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`ask-question-railitem${active ? " active" : ""}`}
      onClick={onClick}
    >
      <span className={`ask-question-railitem-status ${status}`}>
        {status === "answered" ? (
          <CheckIcon size={11} />
        ) : status === "skipped" ? (
          "–"
        ) : (
          index + 1
        )}
      </span>
      <span className="ask-question-railitem-main">
        <span className="ask-question-railitem-cat">
          {question.header || "Question"}
          {question.required ? (
            <span className="ask-question-railitem-req">• required</span>
          ) : (
            <span className="ask-question-railitem-opt">• optional</span>
          )}
        </span>
        <span className="ask-question-railitem-q">{question.question}</span>
        {summary && (
          <span className="ask-question-railitem-answer">{summary}</span>
        )}
      </span>
    </button>
  );
}

export default function AskQuestionPanel({
  questions,
  questionId,
  currentIndex,
  onNavigate,
  onSubmit,
  agent = "claude",
  compact = false,
}: AskQuestionPanelProps) {
  const showKbd = !compact;
  const [view, setView] = useState<"max" | "banner">("max");
  const [drafts, setDrafts] = useState<DraftMap>(() => initDraftMap(questions));
  const [ctxOpen, setCtxOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(questions.map((q, i) => [questionKey(q, i), true])),
  );
  const [search, setSearch] = useState("");
  const sheetRef = useRef<HTMLDivElement>(null);
  const bannerAnswerRef = useRef<HTMLButtonElement>(null);

  const draftFor = useCallback(
    (key: string): AnswerDraft => drafts[key] ?? EMPTY_DRAFT,
    [drafts],
  );
  const patch = useCallback(
    (key: string, fn: (draft: AnswerDraft) => AnswerDraft) =>
      setDrafts((prev) => ({ ...prev, [key]: fn(prev[key] ?? EMPTY_DRAFT) })),
    [],
  );

  const active = Math.min(Math.max(currentIndex, 0), questions.length - 1);
  const q = questions[active];
  const activeKey = q ? questionKey(q, active) : "";

  const progress = useMemo(
    () => computeProgress(questions, drafts),
    [questions, drafts],
  );

  const toggleOpt = useCallback(
    (question: AskQuestionItem, key: string, label: string) =>
      patch(key, (draft) => toggleOption(draft, label, question.multiSelect)),
    [patch],
  );

  const acceptSuggested = useCallback(
    () => setDrafts((prev) => acceptAllSuggested(questions, prev)),
    [questions],
  );

  const skipQuestion = useCallback(
    (key: string) => {
      patch(key, (draft) => ({ ...draft, selected: [], skipped: true }));
      if (active < questions.length - 1) onNavigate(active + 1);
    },
    [patch, active, questions.length, onNavigate],
  );

  const doSubmit = useCallback(() => {
    onSubmit(questionId, buildAnswerPayload(questions, drafts));
  }, [onSubmit, questionId, questions, drafts]);

  // Keyboard answering — desktop, maximized only; suppressed while typing.
  useEffect(() => {
    if (!showKbd || view !== "max") return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName.toLowerCase();
      const typing = tag === "input" || tag === "textarea";
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        if (progress.canSubmit) {
          e.preventDefault();
          doSubmit();
        }
        return;
      }
      // While typing, only the submit chord above is honored; every other
      // shortcut (Escape, 1–9, ↑↓/jk) must fall through as plain text input.
      if (typing) return;
      if (e.key === "Escape") {
        setView("banner");
        return;
      }
      const current = questions[active];
      if (/^[1-9]$/.test(e.key) && current) {
        const optIndex = Number.parseInt(e.key, 10) - 1;
        const option = current.options[optIndex];
        if (option) {
          e.preventDefault();
          toggleOpt(current, questionKey(current, active), option.label);
        }
      }
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        onNavigate(Math.min(questions.length - 1, active + 1));
      }
      if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        onNavigate(Math.max(0, active - 1));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    showKbd,
    view,
    active,
    questions,
    progress.canSubmit,
    doSubmit,
    toggleOpt,
    onNavigate,
  ]);

  // Move focus into the sheet on maximize, back to the banner trigger on minimize.
  useEffect(() => {
    if (view === "max") sheetRef.current?.focus();
    else bannerAnswerRef.current?.focus();
  }, [view]);

  if (!q) return null;
  const draft = draftFor(activeKey);

  const visibleRail = questions
    .map((question, idx) => ({
      question,
      idx,
      key: questionKey(question, idx),
    }))
    .filter(
      ({ question }) =>
        !search ||
        `${question.question} ${question.header ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    );

  return (
    <div
      className="ask-question-overlay"
      data-agent={agent}
      data-compact={compact ? "true" : "false"}
    >
      {view === "max" && (
        <div
          className="ask-question-scrim"
          aria-hidden="true"
          onClick={() => setView("banner")}
        />
      )}

      <div
        className="ask-question-panel"
        data-view={view}
        data-agent={agent}
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Agent question"
      >
        {view === "banner" ? (
          <div className="ask-question-banner">
            <button
              type="button"
              className="ask-question-banner-expand"
              aria-label="Expand question panel"
              onClick={() => setView("max")}
            >
              <span className="ask-question-banner-badge">
                <span className="ask-question-spark" />
                Agent needs your input
              </span>
              <span className="ask-question-banner-progress">
                <span className="ask-question-progress">
                  <i style={{ width: `${progress.percent}%` }} />
                </span>
              </span>
              <span className="ask-question-banner-count">
                <b>{progress.answeredCount}</b> / {questions.length}
                {progress.requiredRemaining > 0
                  ? ` · ${progress.requiredRemaining} required left`
                  : " · ready"}
              </span>
            </button>
            {progress.canSubmit ? (
              <button
                type="button"
                ref={bannerAnswerRef}
                className="ask-question-banner-answer"
                onClick={doSubmit}
              >
                Send answers <ArrowUpIcon size={13} />
              </button>
            ) : (
              <button
                type="button"
                ref={bannerAnswerRef}
                className="ask-question-banner-answer"
                onClick={() => setView("max")}
              >
                Answer <ChevronDownIcon size={13} />
              </button>
            )}
          </div>
        ) : (
          <div className="ask-question-expanded">
            <div className="ask-question-header">
              <button
                type="button"
                className="ask-question-iconbtn"
                title="Minimize — read the conversation"
                aria-label="Minimize"
                onClick={() => setView("banner")}
              >
                <ChevronDownIcon size={14} />
              </button>
              <span className="ask-question-badge">
                <span className="ask-question-spark" />
                Needs your input
              </span>
              <div className="ask-question-header-progress">
                <span className="ask-question-progress">
                  <i style={{ width: `${progress.percent}%` }} />
                </span>
                <span className="ask-question-count">
                  <b>{progress.answeredCount}</b> / {questions.length} answered
                </span>
              </div>
              <div className="ask-question-header-actions">
                {progress.hasSuggestions && (
                  <button
                    type="button"
                    className="ask-question-ghostbtn accent"
                    onClick={acceptSuggested}
                  >
                    <StarIcon size={11} /> Accept all suggested
                  </button>
                )}
              </div>
            </div>

            <div className="ask-question-body">
              {!compact && (
                <div className="ask-question-rail">
                  {questions.length > 5 && (
                    <div className="ask-question-rail-search">
                      <span className="ask-question-rail-search-ic">
                        <SearchIcon size={13} />
                      </span>
                      <input
                        placeholder="Filter questions…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  )}
                  {visibleRail.map(({ question, idx, key }) => (
                    <RailItem
                      key={key}
                      question={question}
                      index={idx}
                      active={idx === active}
                      status={statusOfQuestion(question, draftFor(key))}
                      summary={summaryOfQuestion(draftFor(key))}
                      onClick={() => onNavigate(idx)}
                    />
                  ))}
                </div>
              )}

              <div className="ask-question-main">
                {compact && (
                  <div className="ask-question-pager">
                    <button
                      type="button"
                      className="ask-question-pager-nav prev"
                      disabled={active === 0}
                      onClick={() => onNavigate(Math.max(0, active - 1))}
                      aria-label="Previous question"
                    >
                      <ChevronRightIcon size={13} />
                    </button>
                    <div className="ask-question-pager-chips">
                      {questions.map((question, idx) => {
                        const answered = isAnswered(
                          draftFor(questionKey(question, idx)),
                        );
                        return (
                          <button
                            type="button"
                            key={questionKey(question, idx)}
                            className={`ask-question-chip${idx === active ? " active" : ""}${answered ? " answered" : ""}`}
                            onClick={() => onNavigate(idx)}
                            aria-label={`Question ${idx + 1}`}
                          >
                            {answered ? <CheckIcon size={11} /> : idx + 1}
                          </button>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      className="ask-question-pager-nav"
                      disabled={active === questions.length - 1}
                      onClick={() =>
                        onNavigate(Math.min(questions.length - 1, active + 1))
                      }
                      aria-label="Next question"
                    >
                      <ChevronRightIcon size={13} />
                    </button>
                  </div>
                )}
                <QuestionCard
                  question={q}
                  index={active}
                  total={questions.length}
                  draft={draft}
                  showKbd={showKbd}
                  ctxOpen={ctxOpen[activeKey] ?? true}
                  onCtxToggle={() =>
                    setCtxOpen((prev) => ({
                      ...prev,
                      [activeKey]: !(prev[activeKey] ?? true),
                    }))
                  }
                  onToggleOption={(label) => toggleOpt(q, activeKey, label)}
                  onOtherText={(value) =>
                    patch(activeKey, (d) => ({
                      ...d,
                      otherText: value,
                      selected: d.selected.includes(OTHER_SENTINEL)
                        ? d.selected
                        : q.multiSelect
                          ? [...d.selected, OTHER_SENTINEL]
                          : [OTHER_SENTINEL],
                    }))
                  }
                  onNote={(value) =>
                    patch(activeKey, (d) => ({ ...d, note: value }))
                  }
                  onNoteToggle={() =>
                    patch(activeKey, (d) => ({ ...d, noteOpen: true }))
                  }
                />
              </div>
            </div>

            <div className="ask-question-footer">
              {showKbd && (
                <div className="ask-question-hint">
                  <span className="ask-question-kbd">1–9</span> pick{" "}
                  <span className="ask-question-kbd">↑↓</span> move{" "}
                  <span className="ask-question-kbd">esc</span> minimize{" "}
                  <span className="ask-question-kbd">⌘↵</span> send
                </div>
              )}
              <div className="ask-question-footer-spacer" />
              {progress.requiredRemaining > 0 && (
                <span className="ask-question-warn">
                  {progress.requiredRemaining} required{" "}
                  {progress.requiredRemaining === 1 ? "answer" : "answers"} left
                </span>
              )}
              {!q.required && !isAnswered(draft) && (
                <button
                  type="button"
                  className="ask-question-ghostbtn"
                  onClick={() => skipQuestion(activeKey)}
                >
                  Skip this
                </button>
              )}
              <button
                type="button"
                className="ask-question-submit"
                disabled={!progress.canSubmit}
                onClick={doSubmit}
              >
                Send{" "}
                {progress.answeredCount > 0
                  ? `${progress.answeredCount} ${progress.answeredCount === 1 ? "answer" : "answers"}`
                  : "answers"}
                {showKbd && <span className="ask-question-submit-sk">⌘↵</span>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
