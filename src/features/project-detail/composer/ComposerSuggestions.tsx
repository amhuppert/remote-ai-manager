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
    <ul className="plc-suggestions" role="listbox" aria-label="Suggestions">
      {suggestions.map((s, index) => {
        const showGroup = index === 0 || suggestions[index - 1]?.grp !== s.grp;
        return (
          <li key={suggestionKey(s)} role="presentation">
            {showGroup && (
              <div className="plc-suggestions-group" aria-hidden="true">
                {s.grp}
              </div>
            )}
            <div
              role="option"
              aria-selected={index === activeIndex}
              data-active={index === activeIndex}
              className="plc-suggestion"
              onMouseEnter={() => onHoverIndex?.(index)}
              onMouseDown={(e) => {
                // Prevent the composer textarea from losing focus before apply.
                e.preventDefault();
                onApply(s);
              }}
            >
              {s.kind === "action" ? (
                <>
                  <span className="plc-suggestion-key">/{s.id}</span>
                  <span className="plc-suggestion-meta">{s.label}</span>
                </>
              ) : (
                <>
                  <span className="plc-suggestion-key">
                    {s.key}:{s.value}
                  </span>
                  <span className="plc-suggestion-meta">{s.label}</span>
                </>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
