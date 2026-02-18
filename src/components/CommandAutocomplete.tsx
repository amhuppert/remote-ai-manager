"use client";

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  useImperativeHandle,
  forwardRef,
} from "react";
import { fuzzyMatch } from "@/lib/fuzzy";
import { tracedFetch } from "@/lib/traced-fetch";
import type { CommandItem } from "@/types";

interface ScoredItem {
  item: CommandItem;
  score: number;
  nameIndices: number[];
}

export interface CommandAutocompleteProps {
  promptText: string;
  onPromptChange: (text: string) => void;
  onPlaceholderChange: (placeholder: string) => void;
  projectName: string;
  sessionName: string;
  disabled: boolean;
}

export interface CommandAutocompleteHandle {
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

export const CommandAutocomplete = forwardRef<
  CommandAutocompleteHandle,
  CommandAutocompleteProps
>(function CommandAutocomplete(
  {
    promptText,
    onPromptChange,
    onPlaceholderChange,
    projectName,
    sessionName,
    disabled,
  },
  ref,
) {
  const [items, setItems] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const fetchedRef = useRef(false);

  const visible =
    !disabled && promptText.startsWith("/") && !promptText.includes(" ");
  const query = visible ? promptText.slice(1) : "";

  // Fetch commands on first activation
  useEffect(() => {
    if (!visible || fetchedRef.current || loading) return;

    fetchedRef.current = true;
    setLoading(true);
    setError(null);

    tracedFetch(
      `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/commands`,
      "fetch-commands",
    )
      .then(async (res) => {
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Failed" }));
          throw new Error(
            (data as { error?: string }).error ?? "Failed to load commands",
          );
        }
        const data = (await res.json()) as { items: CommandItem[] };
        setItems(data.items);
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : "Failed to load commands";
        setError(message);
        // Allow retry on next open
        fetchedRef.current = false;
      })
      .finally(() => {
        setLoading(false);
      });
  }, [visible, loading, projectName, sessionName]);

  // Filter and score items
  const filtered = useMemo((): ScoredItem[] => {
    if (items.length === 0) return [];

    const results: ScoredItem[] = [];

    for (const item of items) {
      // Match against name (strip leading /)
      const nameTarget = item.name.slice(1);
      const nameResult = fuzzyMatch(query, nameTarget);

      if (nameResult.match) {
        results.push({
          item,
          score: nameResult.score,
          // Shift indices by 1 to account for the leading / in display
          nameIndices: nameResult.indices.map((i) => i + 1),
        });
        continue;
      }

      // Description matching only for queries >= 3 chars
      if (query.length >= 3) {
        const descResult = fuzzyMatch(query, item.description);
        if (descResult.match) {
          results.push({
            item,
            score: 40,
            nameIndices: [],
          });
        }
      }
    }

    // Sort by score descending, then alphabetically for equal scores
    results.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.item.name.localeCompare(b.item.name);
    });

    return results;
  }, [items, query]);

  // Reset active index when filtered results change
  useEffect(() => {
    setActiveIndex(0);
  }, [filtered.length, query]);

  // Scroll active item into view
  useEffect(() => {
    if (!visible) return;
    const list = listRef.current;
    if (!list) return;
    const activeEl = list.children[activeIndex] as HTMLElement | undefined;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, visible]);

  // Select a command
  const selectItem = useCallback(
    (scoredItem: ScoredItem) => {
      onPromptChange(scoredItem.item.name + " ");
      if (scoredItem.item.argumentHint) {
        onPlaceholderChange(scoredItem.item.argumentHint);
      }
    },
    [onPromptChange, onPlaceholderChange],
  );

  // Keyboard handler - exposed to parent
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!visible) return false;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, filtered.length - 1));
          return true;
        }
        case "ArrowUp": {
          e.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          return true;
        }
        case "Enter":
        case "Tab": {
          e.preventDefault();
          const selected = filtered[activeIndex];
          if (selected) {
            selectItem(selected);
          }
          return true;
        }
        case "Escape": {
          e.preventDefault();
          onPromptChange("");
          return true;
        }
        default:
          return false;
      }
    },
    [visible, filtered, activeIndex, selectItem, onPromptChange],
  );

  // Expose handleKeyDown to parent via ref
  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  if (!visible) return null;

  // Render highlighted name
  function renderName(name: string, indices: number[]) {
    if (indices.length === 0) return <span className="cmd-name">{name}</span>;

    const indexSet = new Set(indices);
    const chars: React.ReactNode[] = [];

    for (let i = 0; i < name.length; i++) {
      if (indexSet.has(i)) {
        chars.push(
          <span key={i} className="cmd-match">
            {name[i]}
          </span>,
        );
      } else {
        chars.push(<span key={i}>{name[i]}</span>);
      }
    }

    return <span className="cmd-name">{chars}</span>;
  }

  return (
    <div className="cmd-autocomplete">
      <div className="cmd-header">
        <span>Commands</span>
        <span className="cmd-header-count">
          {filtered.length} {filtered.length === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="cmd-list" ref={listRef}>
        {loading && <div className="cmd-loading">Loading commands...</div>}

        {error && (
          <div className="cmd-error">
            {error}. Press <kbd>/</kbd> to retry.
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <div className="cmd-empty">No matching commands</div>
        )}

        {!loading &&
          !error &&
          filtered.map((scored, i) => (
            <div
              key={scored.item.name}
              className={`cmd-item${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => selectItem(scored)}
            >
              {renderName(scored.item.name, scored.nameIndices)}
              <span className="cmd-desc">{scored.item.description}</span>
              <span className="cmd-badge" data-type={scored.item.type}>
                {scored.item.type}
              </span>
              <span className="cmd-source">{scored.item.source}</span>
            </div>
          ))}
      </div>

      <div className="cmd-footer">
        <span>
          <kbd>↑</kbd> <kbd>↓</kbd> navigate
        </span>
        <span>
          <kbd>Enter</kbd> select
        </span>
        <span>
          <kbd>Esc</kbd> close
        </span>
      </div>
    </div>
  );
});
