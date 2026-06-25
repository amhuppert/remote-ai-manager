"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { CloseIcon } from "@/components/icons";
import { cn } from "@/lib/ui/cn";
import type { Suggestion } from "./command-suggestions";
import type { FilterCategory, FilterToken } from "./filter-tokens";

export interface CommandConsoleProps {
  tokens: FilterToken[];
  draft: string;
  suggestions: Suggestion[];
  focused: boolean;
  onDraftChange: (next: string) => void;
  onApply: (suggestion: Suggestion) => void;
  onRemoveToken: (cat: FilterCategory) => void;
  onFocus: () => void;
  onBlur: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
}

const barBase =
  "relative flex items-center h-[44px] bg-bg-surface border border-solid rounded-md px-md transition-[border-color,box-shadow] duration-150 ease-[ease]";

const tokenBase =
  "inline-flex items-center gap-[6px] py-[3px] pr-[4px] pl-[8px] rounded-[4px] border border-solid font-mono text-[0.72rem] font-semibold whitespace-nowrap";
// "target"/"branch" fall to the cyan default, matching the legacy
// `.console-token` base.
const tokenCat: Record<FilterCategory, string> = {
  status: "bg-amber-glow border-[var(--cc-amber-a30)] text-amber",
  archived: "bg-bg-raised border-border-default text-text-secondary",
  target: "bg-cyan-glow border-cyan-glow-strong text-cyan",
  branch: "bg-cyan-glow border-cyan-glow-strong text-cyan",
};

const hintKbd =
  "font-mono text-[0.7rem] font-semibold py-[2px] px-[6px] rounded-[4px] bg-bg-base border border-solid border-border-subtle text-text-tertiary";
const hintWord = "text-text-tertiary font-mono text-[0.66rem]";

const suggestListId = "command-console-suggestions";

/** Stable per-row id so the combobox input can target it via aria-activedescendant. */
const suggestionOptionId = (idx: number) => `command-console-option-${idx}`;

/** Stable per-group label id so each role=group can name itself via aria-labelledby. */
const suggestionGroupLabelId = (grp: string) =>
  `command-console-group-${grp.toLowerCase().replace(/\s+/g, "-")}`;

export default function CommandConsole({
  tokens,
  draft,
  suggestions,
  focused,
  onDraftChange,
  onApply,
  onRemoveToken,
  onFocus,
  onBlur,
  inputRef,
}: CommandConsoleProps): React.JSX.Element {
  const [activeIdx, setActiveIdx] = useState(0);
  const [resetKey, setResetKey] = useState<{
    draft: string;
    tokens: FilterToken[];
  }>({ draft, tokens });
  if (resetKey.draft !== draft || resetKey.tokens !== tokens) {
    setResetKey({ draft, tokens });
    setActiveIdx(0);
  }

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!focused) return;

    const handleMouseDown = (e: MouseEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      if (e.target instanceof Node && wrapper.contains(e.target)) return;
      onBlur();
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      inputRef.current?.blur();
      onBlur();
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [focused, onBlur, inputRef]);

  const applyAndClose = (s: Suggestion) => {
    onApply(s);
    inputRef.current?.blur();
    onBlur();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      const target = suggestions[activeIdx];
      if (target) {
        e.preventDefault();
        applyAndClose(target);
      }
      return;
    }
    if (e.key === "Backspace" && draft === "" && tokens.length > 0) {
      const last = tokens[tokens.length - 1];
      if (last) onRemoveToken(last.cat);
      return;
    }
    if (e.key === "Escape") {
      onBlur();
      inputRef.current?.blur();
      return;
    }
  };

  const placeholder =
    tokens.length === 0
      ? "Filter sessions, or type / for actions…"
      : "+ filter or /action";

  const listOpen = focused && suggestions.length > 0;
  const activeOptionId =
    listOpen && suggestions[activeIdx] !== undefined
      ? suggestionOptionId(activeIdx)
      : undefined;

  return (
    <div
      className="relative z-header flex flex-col gap-sm px-xl py-md max-768:px-md max-768:py-sm"
      ref={wrapperRef}
    >
      <div
        className={cn(
          barBase,
          focused
            ? "border-cyan shadow-[0_0_0_3px_var(--color-cyan-glow)]"
            : "border-border-default",
        )}
        onClick={() => inputRef.current?.focus()}
      >
        <span className="mr-[10px] font-mono font-bold text-cyan [text-shadow:0_0_6px_var(--color-cyan-glow)]">
          ›
        </span>
        <div className="flex flex-wrap items-center gap-[6px]">
          {tokens.map((t) => (
            <span key={t.cat} className={cn(tokenBase, tokenCat[t.cat])}>
              <span className="font-medium text-text-secondary">{t.key}:</span>
              <span>{t.value}</span>
              <button
                type="button"
                className="inline-flex size-[16px] items-center justify-center rounded-[3px] text-text-tertiary hover:bg-cyan-glow hover:text-cyan"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveToken(t.cat);
                }}
                aria-label={`Remove filter ${t.cat}`}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={suggestListId}
            aria-expanded={listOpen}
            aria-activedescendant={activeOptionId}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onFocus={onFocus}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="h-[44px] min-w-[200px] flex-1 border-0 bg-transparent font-mono text-[0.9rem] text-text-primary outline-0 placeholder:text-text-tertiary"
          />
        </div>
        <div className="ml-md flex shrink-0 gap-[6px] max-768:hidden">
          {!focused ? (
            <>
              <kbd className={hintKbd}>⌘K</kbd>
              <span className={cn(hintWord, "px-[2px] pr-[6px]")}>focus</span>
              <kbd className={hintKbd}>/</kbd>
              <span className={cn(hintWord, "px-[2px] pr-[6px]")}>actions</span>
              <kbd className={hintKbd}>:</kbd>
              <span className={cn(hintWord, "px-[2px]")}>filter</span>
            </>
          ) : (
            <span className={hintWord}>↑↓ nav · ⏎ apply · esc close</span>
          )}
        </div>

        {listOpen && (
          <div
            className="absolute top-[calc(100%+8px)] right-0 left-0 z-header animate-[kebab-in_0.12s_ease] rounded-md border border-solid border-border-default bg-bg-elevated p-[6px] shadow-[var(--cc-shadow-popover)]"
            id={suggestListId}
            role="listbox"
            aria-label="Command and filter suggestions"
          >
            <SuggestionGroups
              suggestions={suggestions}
              activeIdx={activeIdx}
              onApply={applyAndClose}
              onHover={setActiveIdx}
            />
          </div>
        )}
      </div>
    </div>
  );
}

interface SuggestionGroupsProps {
  suggestions: Suggestion[];
  activeIdx: number;
  onApply: (s: Suggestion) => void;
  onHover: (idx: number) => void;
}

const suggestItemBase =
  "flex items-center gap-[10px] w-full py-[7px] px-[10px] border-0 rounded-sm text-text-primary font-mono text-[0.76rem] text-left cursor-pointer [&_svg]:text-text-tertiary";
const kindColor = {
  action: "text-violet",
  filter: "text-cyan",
} as const;

function SuggestionGroups({
  suggestions,
  activeIdx,
  onApply,
  onHover,
}: SuggestionGroupsProps): React.JSX.Element {
  const groups = new Map<
    string,
    Array<{ suggestion: Suggestion; idx: number }>
  >();
  suggestions.forEach((s, idx) => {
    const list = groups.get(s.grp) ?? [];
    list.push({ suggestion: s, idx });
    groups.set(s.grp, list);
  });

  return (
    <>
      {Array.from(groups.entries()).map(([grp, items]) => (
        <div
          key={grp}
          role="group"
          aria-labelledby={suggestionGroupLabelId(grp)}
        >
          <div
            id={suggestionGroupLabelId(grp)}
            className="block px-[10px] pt-[6px] pb-[4px] font-mono text-[0.7rem] font-semibold tracking-[0.08em] text-text-tertiary uppercase"
          >
            {grp}
          </div>
          {items.map(({ suggestion, idx }) => (
            // role=option on a div (not a button): DOM focus stays on the
            // combobox input (managed focus), so options must not be tab-focusable.
            <div
              key={idx}
              id={suggestionOptionId(idx)}
              role="option"
              aria-selected={idx === activeIdx}
              data-active={idx === activeIdx}
              className={cn(
                suggestItemBase,
                idx === activeIdx
                  ? "bg-cyan-glow"
                  : "bg-transparent hover:bg-cyan-glow",
              )}
              onMouseEnter={() => onHover(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onApply(suggestion);
              }}
            >
              <span>{suggestion.label}</span>
              <span
                className={cn(
                  "ml-auto text-[0.7rem] tracking-[0.08em] uppercase",
                  kindColor[suggestion.kind],
                )}
              >
                {suggestion.kind}
              </span>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}
