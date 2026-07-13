"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AskQuestionAnswer,
  AskQuestionItem,
} from "@/lib/conversations/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { cn } from "@/lib/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { CompactMarkdown } from "@/components/markdown/Markdown";
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
  questionKey,
  statusOfQuestion,
  summaryOfQuestion,
  toggleOption,
  type AnswerDraft,
  type DraftMap,
  type QuestionStatus,
} from "@/components/ask-question-logic";

interface AskQuestionPanelProps {
  questions: AskQuestionItem[];
  questionId: string;
  /** Active question index — controlled by the store (docked) or peek nav. */
  currentIndex: number;
  onNavigate: (index: number) => void;
  /**
   * Returning a promise puts the submit controls into a visible pending state
   * (spinner + disabled) until it settles — fire-and-forget handlers keep the
   * previous behavior.
   */
  onSubmit: (
    questionId: string,
    answers: Record<string, AskQuestionAnswer>,
  ) => void | Promise<void>;
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

// Shared recipes. The accent is themed per-agent through the `--aq-accent*`
// custom properties set on the panel (cyan default, violet for codex), so every
// `var(--aq-accent*)` reference below resolves to the asking agent's color.
const badgeBase =
  "inline-flex items-center whitespace-nowrap font-mono font-semibold uppercase tracking-[0.05em] text-[color:var(--aq-accent)]";
const sparkClass =
  "h-[8px] w-[8px] rounded-full bg-[var(--aq-accent)] shadow-[0_0_10px_var(--aq-accent)] [animation:pulse-dot_1.8s_ease-in-out_infinite] motion-reduce:animate-none";
const progressTrackClass =
  "relative h-[5px] flex-1 overflow-hidden rounded-[3px] border border-solid border-border-subtle bg-bg-base";
const progressFillClass =
  "absolute top-0 right-auto bottom-0 left-0 rounded-[3px] bg-[linear-gradient(90deg,var(--aq-accent-dim),var(--aq-accent))] shadow-[0_0_12px_var(--aq-accent-glow-strong)] [transition:width_0.35s_cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none";
const ghostBtnBase =
  "inline-flex cursor-pointer items-center gap-[6px] whitespace-nowrap rounded-md border border-solid bg-transparent px-[10px] py-[6px] font-mono text-[0.7rem] font-medium [transition:all_0.14s_ease] enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";
const ghostBtnPlain =
  "border-border-default text-text-secondary enabled:hover:border-border-strong enabled:hover:bg-bg-hover";
const ghostBtnAccent =
  "border-[color:color-mix(in_srgb,var(--aq-accent)_40%,transparent)] text-[color:var(--aq-accent)] enabled:hover:border-[color:var(--aq-accent)] enabled:hover:bg-[var(--aq-accent-glow)]";
const iconBtnClass =
  "inline-flex h-[30px] w-[30px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-border-default bg-transparent text-text-secondary [transition:all_0.14s_ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary group-data-[compact=true]/aq:min-h-[var(--touch-target-min)]";
const bannerAnswerClass =
  "inline-flex cursor-pointer items-center gap-[8px] whitespace-nowrap rounded-md border border-solid border-[color:var(--aq-accent)] bg-[var(--aq-accent)] px-[16px] py-[8px] font-body text-[0.82rem] font-bold text-bg-void [transition:all_0.15s_ease] hover:bg-[var(--aq-accent-dim)] hover:shadow-[0_0_24px_var(--aq-accent-glow-strong)] group-data-[compact=true]/aq:min-h-[var(--touch-target-min)]";

const tagBase =
  "rounded-full px-[7px] py-[2px] font-mono text-[0.6rem] font-semibold uppercase tracking-[0.04em]";
const tagClass: Record<"required" | "optional" | "multi", string> = {
  required: "bg-[var(--aq-accent-glow)] text-[color:var(--aq-accent)]",
  optional: "border border-solid border-border-default text-text-tertiary",
  multi: "bg-green-glow text-green",
};

// Option container: base is the resting appearance; hover is gated to the
// unselected state and selected wins via its own data-variant — no reliance on
// utility emission order (the active-beats-hover idiom).
const optionContainerClass =
  "group/aqopt relative flex cursor-pointer items-start gap-[11px] rounded-md border border-solid border-border-subtle bg-bg-base px-md py-[11px] [transition:border-color_0.14s_ease,background_0.14s_ease,box-shadow_0.14s_ease] data-[selected=false]:hover:border-[color:var(--aq-accent-dim)] data-[selected=false]:hover:bg-[color-mix(in_srgb,var(--aq-accent)_4%,var(--bg-base))] data-[selected=true]:border-[color:var(--aq-accent)] data-[selected=true]:bg-[color-mix(in_srgb,var(--aq-accent)_9%,var(--bg-base))] data-[selected=true]:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--aq-accent)_40%,transparent)] group-data-[compact=true]/aq:min-h-[var(--touch-target-min)]";
const optionMarkBase =
  "mt-[1px] grid h-[18px] w-[18px] flex-shrink-0 place-items-center border-[1.5px] border-solid border-border-strong text-transparent [transition:all_0.14s_ease] group-data-[selected=true]/aqopt:border-[color:var(--aq-accent)] group-data-[selected=true]/aqopt:bg-[var(--aq-accent)] group-data-[selected=true]/aqopt:text-bg-void group-data-[selected=true]/aqopt:shadow-[0_0_10px_var(--aq-accent-glow-strong)]";
const optionDotClass = "h-[8px] w-[8px] rounded-full bg-bg-void";
const optionContentClass = "flex min-w-0 flex-1 flex-col pr-[18px]";
const optionLabelRowClass = "flex flex-wrap items-center gap-[8px]";
const optionLabelClass = "text-[0.88rem] font-semibold text-text-primary";
const suggestedClass =
  "inline-flex items-center gap-[4px] rounded-full bg-amber-glow px-[6px] py-[2px] font-mono text-[0.58rem] font-semibold uppercase tracking-[0.04em] text-amber";
const tradeoffRowClass =
  "mt-[5px] flex gap-[7px] text-[0.74rem] leading-[1.45] text-text-tertiary";
const tradeoffTickClass =
  "flex-shrink-0 pt-[1px] font-mono text-[0.6rem] font-bold";
const optionKbdClass =
  "absolute top-[8px] right-[10px] rounded-sm border border-solid border-border-default px-[5px] font-mono text-[0.62rem] leading-[1.5] text-text-tertiary opacity-70";
const otherInputClass =
  "mt-[9px] w-full rounded-sm border border-solid border-border-default bg-bg-surface px-[10px] py-[8px] font-body text-[0.84rem] text-text-primary outline-none focus:border-[color:var(--aq-accent-dim)]";

const noteToggleClass =
  "inline-flex cursor-pointer items-center gap-[7px] border-none bg-transparent p-0 font-mono text-[0.7rem] text-text-secondary [transition:color_0.13s_ease] hover:text-[color:var(--aq-accent)] group-data-[compact=true]/aq:min-h-[var(--touch-target-min)]";
const notePlusClass =
  "grid h-[16px] w-[16px] place-items-center rounded-sm border border-solid border-border-default";
const noteTextareaClass =
  "min-h-[64px] w-full resize-y rounded-md border border-solid border-border-default bg-bg-base px-[12px] py-[10px] font-body text-[0.84rem] leading-[1.5] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[color:var(--aq-accent-dim)] focus:shadow-[0_0_0_3px_var(--aq-accent-glow)]";
const noteLabelClass =
  "mb-[6px] flex items-center gap-[7px] font-mono text-[0.64rem] font-semibold uppercase tracking-[0.05em] text-text-tertiary";

// Rail status pip: base carries structure only; each status supplies its border
// style + color so there is no base-vs-variant property collision.
const railStatusBase =
  "mt-[1px] grid h-[16px] w-[16px] flex-shrink-0 place-items-center rounded-full border-[1.5px] font-mono text-[0.62rem] font-bold";
const railStatusClass: Record<QuestionStatus, string> = {
  "": "border-solid border-border-strong text-text-tertiary",
  answered: "border-solid border-green bg-green text-bg-void",
  suggested: "border-solid border-amber text-amber",
  skipped: "border-dashed border-border-strong text-text-tertiary",
  "required-empty":
    "border-solid border-[color:var(--aq-accent)] text-[color:var(--aq-accent)]",
};

const pagerNavClass =
  "inline-flex h-[34px] w-[34px] flex-shrink-0 cursor-pointer items-center justify-center rounded-md border border-solid border-border-default bg-bg-surface text-text-secondary enabled:hover:border-border-strong enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 group-data-[compact=true]/aq:min-h-[var(--touch-target-min)]";
const chipBase =
  "inline-flex h-[30px] min-w-[30px] flex-shrink-0 cursor-pointer items-center justify-center gap-[5px] rounded-full border border-solid px-[9px] font-mono text-[0.72rem] font-semibold [transition:all_0.13s_ease] group-data-[compact=true]/aq:h-[var(--touch-target-min)] group-data-[compact=true]/aq:min-w-[var(--touch-target-min)]";
type ChipState = "default" | "active" | "answered" | "both";
const chipStateClass: Record<ChipState, string> = {
  default: "border-border-default bg-bg-surface text-text-secondary",
  active:
    "border-[color:var(--aq-accent)] bg-[var(--aq-accent-glow)] text-[color:var(--aq-accent)]",
  answered: "border-green bg-bg-surface text-green",
  both: "border-green bg-green-glow text-green",
};

const kbdClass =
  "rounded-sm border border-solid border-border-default border-b-2 bg-bg-surface px-[5px] py-[1px] font-mono text-[0.64rem] text-text-secondary";
const submitClass =
  "inline-flex cursor-pointer items-center gap-[9px] whitespace-nowrap rounded-md border border-solid border-[color:var(--aq-accent)] bg-[var(--aq-accent)] px-[20px] py-[10px] font-body text-[0.86rem] font-bold text-bg-void [transition:all_0.15s_ease] enabled:hover:bg-[var(--aq-accent-dim)] enabled:hover:shadow-[0_0_28px_var(--aq-accent-glow-strong)] disabled:cursor-not-allowed disabled:opacity-40 group-data-[compact=true]/aq:min-h-[var(--touch-target-min)] group-data-[compact=true]/aq:flex-1 group-data-[compact=true]/aq:justify-center";
const submitSkClass =
  "border-y-0 border-r-0 border-l border-solid border-l-[color:color-mix(in_srgb,var(--bg-void)_30%,transparent)] pl-[9px] font-mono text-[0.66rem] font-medium opacity-70";

function ProgressBar({
  percent,
  className,
}: {
  percent: number;
  className?: string;
}) {
  return (
    <span className={cn(progressTrackClass, className)}>
      <i className={progressFillClass} style={{ width: `${percent}%` }} />
    </span>
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
    <div className="mb-md overflow-hidden rounded-md border border-l-2 border-solid border-border-subtle border-l-[color:var(--aq-accent)] bg-bg-base">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-[8px] border-none bg-transparent px-md py-[9px] text-left font-mono text-[0.68rem] font-semibold tracking-[0.05em] text-[color:var(--aq-accent)] uppercase"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>Context · trade-offs</span>
        <span
          className={cn(
            "ml-auto flex text-text-tertiary [transition:transform_0.18s_ease]",
            open && "rotate-90",
          )}
        >
          <ChevronRightIcon size={11} />
        </span>
      </button>
      {open && (
        <div className="pr-md pb-md pl-[calc(var(--space-md)+22px)]">
          <CompactMarkdown content={question.context} />
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
      className={optionContainerClass}
      data-selected={selected}
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
        className={cn(
          optionMarkBase,
          multiSelect ? "rounded-sm" : "rounded-full",
        )}
        aria-hidden="true"
      >
        {selected &&
          (multiSelect ? (
            <CheckIcon size={12} />
          ) : (
            <span className={optionDotClass} />
          ))}
      </span>
      <span className={optionContentClass}>
        <span className={optionLabelRowClass}>
          <span className={optionLabelClass}>{option.label}</span>
          {option.recommended && (
            <span className={suggestedClass}>
              <StarIcon size={9} /> Suggested
            </span>
          )}
        </span>
        {option.description && (
          <span className="mt-[3px] text-[0.78rem] leading-[1.45] text-text-secondary">
            {option.description}
          </span>
        )}
        {option.tradeoff?.pro && (
          <span className={tradeoffRowClass}>
            <span className={cn(tradeoffTickClass, "text-green")}>+</span>
            <span>{option.tradeoff.pro}</span>
          </span>
        )}
        {option.tradeoff?.con && (
          <span className={tradeoffRowClass}>
            <span className={cn(tradeoffTickClass, "text-amber-dim")}>−</span>
            <span>{option.tradeoff.con}</span>
          </span>
        )}
      </span>
      {showKbd && index < 9 && (
        <span className={optionKbdClass}>{index + 1}</span>
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
    <div className="max-w-[720px] group-data-[compact=true]/aq:max-w-none">
      <div className="mb-sm flex flex-wrap items-center gap-[10px]">
        {question.header && (
          <span className="font-mono text-[0.66rem] font-semibold tracking-[0.06em] text-text-tertiary uppercase">
            {question.header}
          </span>
        )}
        {question.required ? (
          <span className={cn(tagBase, tagClass.required)}>Required</span>
        ) : (
          <span className={cn(tagBase, tagClass.optional)}>Optional</span>
        )}
        {question.multiSelect && (
          <span className={cn(tagBase, tagClass.multi)}>Select multiple</span>
        )}
        <span className="ml-auto font-mono text-[0.66rem] text-text-tertiary">
          Q{index + 1} / {total}
        </span>
      </div>
      <div className="mb-sm font-body text-[1.04rem] leading-[1.4] font-semibold tracking-[-0.01em] text-pretty text-text-primary group-data-[compact=true]/aq:text-[1rem]">
        {question.question}
      </div>
      <ContextDisclosure
        question={question}
        open={ctxOpen}
        onToggle={onCtxToggle}
      />
      <div className="flex flex-col gap-[6px]">
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
          className={optionContainerClass}
          data-selected={otherSelected}
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
            className={cn(
              optionMarkBase,
              question.multiSelect ? "rounded-sm" : "rounded-full",
            )}
            aria-hidden="true"
          >
            {otherSelected &&
              (question.multiSelect ? (
                <CheckIcon size={12} />
              ) : (
                <span className={optionDotClass} />
              ))}
          </span>
          <span className={optionContentClass}>
            <span className={optionLabelRowClass}>
              <span className={optionLabelClass}>Something else…</span>
            </span>
            {otherSelected && (
              <input
                className={otherInputClass}
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
        <div className="mt-md">
          {draft.noteOpen ? (
            <div className="mt-[8px]">
              <div className={noteLabelClass}>
                Your note{" "}
                <span className="font-normal opacity-60">
                  · sent with your selection
                </span>
              </div>
              <textarea
                className={noteTextareaClass}
                placeholder="e.g. 'Go with SQLite, but gate it behind a flag for the first release.'"
                value={draft.note}
                autoFocus
                onChange={(e) => onNote(e.target.value)}
              />
            </div>
          ) : (
            <button
              type="button"
              className={noteToggleClass}
              onClick={onNoteToggle}
            >
              <span className={notePlusClass}>
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
      className="group/railitem flex w-full cursor-pointer items-start gap-[9px] rounded-md border border-solid border-transparent bg-transparent px-[10px] py-[8px] text-left [transition:background_0.13s_ease,border-color_0.13s_ease] hover:bg-bg-surface data-[active=true]:border-border-default data-[active=true]:bg-bg-surface"
      data-active={active}
      onClick={onClick}
    >
      <span className={cn(railStatusBase, railStatusClass[status])}>
        {status === "answered" ? (
          <CheckIcon size={11} />
        ) : status === "skipped" ? (
          "–"
        ) : (
          index + 1
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-[6px] font-mono text-[0.6rem] font-semibold tracking-[0.05em] text-text-tertiary uppercase">
          {question.header || "Question"}
          {question.required ? (
            <span className="text-[color:var(--aq-accent)]">• required</span>
          ) : (
            <span className="text-text-tertiary opacity-70">• optional</span>
          )}
        </span>
        <span className="mt-[2px] line-clamp-2 text-[0.78rem] leading-[1.35] text-text-secondary group-data-[active=true]/railitem:text-text-primary">
          {question.question}
        </span>
        {summary && (
          <span className="mt-[3px] truncate text-[0.7rem] text-[color:var(--aq-accent)]">
            {summary}
          </span>
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
  const [submitting, setSubmitting] = useState(false);
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
    if (submitting) return;
    const result = onSubmit(questionId, buildAnswerPayload(questions, drafts));
    if (result instanceof Promise) {
      setSubmitting(true);
      result.then(
        () => setSubmitting(false),
        () => setSubmitting(false),
      );
    }
  }, [onSubmit, questionId, questions, drafts, submitting]);

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
        className="group/aq pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-t-lg border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface bg-[radial-gradient(120%_70%_at_50%_0%,var(--aq-accent-glow)_0%,transparent_55%)] shadow-[0_-8px_24px_color-mix(in_srgb,var(--cc-black-a50)_70%,transparent)] outline-none [--aq-accent-dim:var(--cyan-dim)] [--aq-accent-glow-strong:var(--cyan-glow-strong)] [--aq-accent-glow:var(--cyan-glow)] [--aq-accent:var(--cyan)] [transition:height_0.28s_cubic-bezier(0.2,0.8,0.2,1)] data-[agent=codex]:[--aq-accent-dim:var(--violet-dim)] data-[agent=codex]:[--aq-accent-glow-strong:var(--violet-glow-strong)] data-[agent=codex]:[--aq-accent-glow:var(--violet-glow)] data-[agent=codex]:[--aq-accent:var(--violet)] data-[view=banner]:h-[var(--ask-question-banner-h)] data-[view=max]:h-[86%] data-[view=max]:max-h-[680px] data-[compact=true]:data-[view=max]:h-[93%] data-[compact=true]:data-[view=max]:max-h-none motion-reduce:transition-none"
        data-view={view}
        data-agent={agent}
        data-compact={compact ? "true" : "false"}
        ref={sheetRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Agent question"
      >
        {view === "banner" ? (
          <div className="flex h-[var(--ask-question-banner-h)] items-center gap-md px-lg">
            <button
              type="button"
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-md border-none bg-transparent p-0 text-left text-inherit"
              aria-label="Expand question panel"
              onClick={() => setView("max")}
            >
              <span className={cn(badgeBase, "gap-[9px] text-[0.72rem]")}>
                <span className={sparkClass} />
                Agent needs your input
              </span>
              <span className="flex min-w-0 flex-1 items-center group-data-[compact=true]/aq:hidden">
                <ProgressBar
                  percent={progress.percent}
                  className="max-w-[220px]"
                />
              </span>
              <span className="font-mono text-[0.72rem] whitespace-nowrap text-text-secondary group-data-[compact=true]/aq:ml-auto">
                <b className="font-semibold text-text-primary">
                  {progress.answeredCount}
                </b>{" "}
                / {questions.length}
                {progress.requiredRemaining > 0
                  ? ` · ${progress.requiredRemaining} required left`
                  : " · ready"}
              </span>
            </button>
            {progress.canSubmit ? (
              <button
                type="button"
                ref={bannerAnswerRef}
                className={cn(
                  bannerAnswerClass,
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
                disabled={submitting}
                aria-busy={submitting || undefined}
                onClick={doSubmit}
              >
                {submitting ? (
                  <>
                    Sending… <Spinner size="sm" tone="inherit" />
                  </>
                ) : (
                  <>
                    Send answers <ArrowUpIcon size={13} />
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                ref={bannerAnswerRef}
                className={bannerAnswerClass}
                onClick={() => setView("max")}
              >
                Answer <ChevronDownIcon size={13} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-shrink-0 items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-subtle px-xl py-md group-data-[compact=true]/aq:gap-sm group-data-[compact=true]/aq:px-md group-data-[compact=true]/aq:py-sm">
              <button
                type="button"
                className={iconBtnClass}
                title="Minimize — read the conversation"
                aria-label="Minimize"
                onClick={() => setView("banner")}
              >
                <ChevronDownIcon size={14} />
              </button>
              <span className={cn(badgeBase, "gap-[8px] text-[0.7rem]")}>
                <span className={sparkClass} />
                Needs your input
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-[10px]">
                <ProgressBar
                  percent={progress.percent}
                  className="max-w-[260px] group-data-[compact=true]/aq:hidden"
                />
                <span className="font-mono text-[0.7rem] whitespace-nowrap text-text-secondary group-data-[compact=true]/aq:hidden">
                  <b className="font-semibold text-text-primary">
                    {progress.answeredCount}
                  </b>{" "}
                  / {questions.length} answered
                </span>
              </div>
              <div className="flex items-center gap-sm">
                {progress.hasSuggestions && (
                  <button
                    type="button"
                    className={cn(
                      ghostBtnBase,
                      ghostBtnAccent,
                      "group-data-[compact=true]/aq:px-[8px] group-data-[compact=true]/aq:py-[6px] group-data-[compact=true]/aq:text-[0.66rem]",
                    )}
                    onClick={acceptSuggested}
                  >
                    <StarIcon size={11} /> Accept all suggested
                  </button>
                )}
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-[256px_1fr] group-data-[compact=true]/aq:grid-cols-[1fr]">
              {!compact && (
                <div className="flex flex-col gap-[3px] overflow-y-auto border-y-0 border-r border-l-0 border-solid border-border-subtle bg-bg-base p-sm">
                  {questions.length > 5 && (
                    <div className="relative mb-xs">
                      <span className="absolute top-1/2 left-[9px] flex -translate-y-1/2 text-text-tertiary">
                        <SearchIcon size={13} />
                      </span>
                      <input
                        className="w-full rounded-md border border-solid border-border-subtle bg-bg-surface py-[7px] pr-[10px] pl-[30px] font-body text-[0.78rem] text-text-primary outline-none focus:border-[color:var(--aq-accent-dim)]"
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

              <div className="min-h-0 overflow-y-auto px-xl pt-lg pb-md group-data-[compact=true]/aq:px-lg group-data-[compact=true]/aq:py-md">
                {compact && (
                  <div className="flex flex-shrink-0 items-center gap-[8px] border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-base px-md py-sm">
                    <button
                      type="button"
                      className={cn(pagerNavClass, "[&_svg]:-scale-x-100")}
                      disabled={active === 0}
                      onClick={() => onNavigate(Math.max(0, active - 1))}
                      aria-label="Previous question"
                    >
                      <ChevronRightIcon size={13} />
                    </button>
                    <div className="ask-question-pager-chips flex flex-1 [scrollbar-width:none] gap-[6px] overflow-x-auto py-[2px]">
                      {questions.map((question, idx) => {
                        const answered = isAnswered(
                          draftFor(questionKey(question, idx)),
                        );
                        const chipState: ChipState =
                          idx === active && answered
                            ? "both"
                            : idx === active
                              ? "active"
                              : answered
                                ? "answered"
                                : "default";
                        return (
                          <button
                            type="button"
                            key={questionKey(question, idx)}
                            className={cn(chipBase, chipStateClass[chipState])}
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
                      className={pagerNavClass}
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

            <div className="flex flex-shrink-0 items-center gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle bg-bg-base px-xl py-md group-data-[compact=true]/aq:px-md group-data-[compact=true]/aq:py-sm">
              {showKbd && (
                <div className="flex flex-wrap items-center gap-[6px] font-mono text-[0.68rem] text-text-tertiary">
                  <span className={kbdClass}>1–9</span> pick{" "}
                  <span className={kbdClass}>↑↓</span> move{" "}
                  <span className={kbdClass}>esc</span> minimize{" "}
                  <span className={kbdClass}>⌘↵</span> send
                </div>
              )}
              <div className="flex-1" />
              {progress.requiredRemaining > 0 && (
                <span className="font-mono text-[0.68rem] whitespace-nowrap text-amber">
                  {progress.requiredRemaining} required{" "}
                  {progress.requiredRemaining === 1 ? "answer" : "answers"} left
                </span>
              )}
              {!q.required && !isAnswered(draft) && (
                <button
                  type="button"
                  className={cn(ghostBtnBase, ghostBtnPlain)}
                  disabled={submitting}
                  onClick={() => skipQuestion(activeKey)}
                >
                  Skip this
                </button>
              )}
              <button
                type="button"
                className={submitClass}
                disabled={!progress.canSubmit || submitting}
                aria-busy={submitting || undefined}
                onClick={doSubmit}
              >
                {submitting ? (
                  <>
                    Sending… <Spinner size="sm" tone="inherit" />
                  </>
                ) : (
                  <>
                    Send{" "}
                    {progress.answeredCount > 0
                      ? `${progress.answeredCount} ${progress.answeredCount === 1 ? "answer" : "answers"}`
                      : "answers"}
                    {showKbd && <span className={submitSkClass}>⌘↵</span>}
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
