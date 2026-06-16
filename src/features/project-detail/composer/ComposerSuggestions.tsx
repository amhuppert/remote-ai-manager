import type { Suggestion } from "../components/command-suggestions";

export interface ComposerSuggestionsProps {
  suggestions: Suggestion[];
  /** Flat index of the highlighted suggestion (keyboard nav, owned by parent). */
  activeIndex: number;
  onApply: (suggestion: Suggestion) => void;
  onHoverIndex?: (index: number) => void;
}

function suggestionKey(s: Suggestion): string {
  return s.kind === "action" ? `action:${s.id}` : `filter:${s.cat}:${s.value}`;
}

/**
 * Command/filter suggestion surface for the unified composer. Presentational:
 * it renders `computeSuggestions` output grouped by `grp` with the highlighted
 * row flagged via `data-active`, reusing the legacy console's suggestion-list
 * semantics. Keyboard navigation (↑↓ to move the highlight, ⏎ to apply) is owned
 * by the composer that drives `activeIndex`; pointer hover/click are handled here.
 */
export default function ComposerSuggestions({
  suggestions,
  activeIndex,
  onApply,
  onHoverIndex,
}: ComposerSuggestionsProps): React.JSX.Element | null {
  if (suggestions.length === 0) return null;

  return (
    <ul
      className="m-0 max-h-72 list-none overflow-y-auto rounded-md border border-solid border-border-default bg-bg-elevated p-2xs shadow-[0_12px_32px_rgba(0,0,0,0.35)]"
      role="listbox"
      aria-label="Suggestions"
    >
      {suggestions.map((s, index) => {
        const showGroup = index === 0 || suggestions[index - 1]?.grp !== s.grp;
        return (
          <li key={suggestionKey(s)} role="presentation">
            {showGroup && (
              <div
                className="px-sm pt-xs pb-2xs font-mono text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-text-tertiary"
                aria-hidden="true"
              >
                {s.grp}
              </div>
            )}
            <div
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex}
              className={SUGGESTION_CLASS}
              onMouseEnter={() => onHoverIndex?.(index)}
              onMouseDown={(e) => {
                // Prevent the composer textarea from losing focus before apply.
                e.preventDefault();
                onApply(s);
              }}
            >
              {s.kind === "action" ? (
                <>
                  <span className="text-text-primary">/{s.id}</span>
                  <span className="ml-auto text-[0.7rem] text-text-tertiary">
                    {s.label}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-text-primary">
                    {s.key}:{s.value}
                  </span>
                  <span className="ml-auto text-[0.7rem] text-text-tertiary">
                    {s.label}
                  </span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// The keyboard-driven active row and pointer hover share one highlight; the
// active override is gated to `data-active=false` so exactly one variant writes
// `background`/`color` on a row at any time (active wins, never both at once).
const SUGGESTION_CLASS =
  "flex items-center gap-sm rounded-sm px-sm py-xs font-mono text-[0.78rem] text-text-secondary cursor-pointer transition-[background,color] duration-150 ease-[ease] " +
  "data-[active=true]:bg-bg-hover data-[active=true]:text-text-primary " +
  "data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary";
