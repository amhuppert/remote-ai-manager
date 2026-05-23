"use client";

import { useState, type RefObject } from "react";
import { CloseIcon } from "@/components/icons";
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

  const suggestListId = "command-console-suggestions";

  return (
    <div className="v2-console">
      <div
        className={"console-bar" + (focused ? " focused" : "")}
        onClick={() => inputRef.current?.focus()}
      >
        <span className="prompt-glyph">›</span>
        <div className="console-tokens">
          {tokens.map((t) => (
            <span key={t.cat} className="console-token" data-cat={t.cat}>
              <span className="tk-key">{t.key}:</span>
              <span>{t.value}</span>
              <button
                type="button"
                className="tk-x"
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
            aria-expanded={focused && suggestions.length > 0}
            value={draft}
            onChange={(e) => onDraftChange(e.target.value)}
            onFocus={onFocus}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            style={{ minWidth: 200 }}
          />
        </div>
        <div className="console-hints">
          {!focused ? (
            <>
              <kbd>⌘K</kbd>
              <span
                style={{
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: ".66rem",
                  padding: "0 6px 0 2px",
                }}
              >
                focus
              </span>
              <kbd>/</kbd>
              <span
                style={{
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: ".66rem",
                  padding: "0 6px 0 2px",
                }}
              >
                actions
              </span>
              <kbd>:</kbd>
              <span
                style={{
                  color: "var(--text-tertiary)",
                  fontFamily: "var(--font-mono)",
                  fontSize: ".66rem",
                  padding: "0 2px",
                }}
              >
                filter
              </span>
            </>
          ) : (
            <span
              style={{
                color: "var(--text-tertiary)",
                fontFamily: "var(--font-mono)",
                fontSize: ".66rem",
              }}
            >
              ↑↓ nav · ⏎ apply · esc close
            </span>
          )}
        </div>

        {focused && suggestions.length > 0 && (
          <div className="console-suggest" id={suggestListId}>
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
        <div key={grp}>
          <div className="grp-label">{grp}</div>
          {items.map(({ suggestion, idx }) => (
            <button
              key={idx}
              type="button"
              className={
                "suggest-item " +
                suggestion.kind +
                (idx === activeIdx ? " active" : "")
              }
              onMouseEnter={() => onHover(idx)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation();
                onApply(suggestion);
              }}
            >
              <span>{suggestion.label}</span>
              <span className="kind">{suggestion.kind}</span>
            </button>
          ))}
        </div>
      ))}
    </>
  );
}
