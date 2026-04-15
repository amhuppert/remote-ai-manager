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
import { fuzzyMatch, compareFuzzyResults } from "@/lib/fuzzy";
import type { MatchTier } from "@/lib/fuzzy";
import {
  useCommandsQuery,
  useProjectCommandsQuery,
  useKiroDocTreeQuery,
} from "@/lib/queries";
import type { AgentBackendId, CommandItem } from "@/types";

interface ScoredItem {
  item: CommandItem;
  tier: MatchTier;
  coverage: number;
  nameIndices: number[];
}

interface ScoredFeature {
  name: string;
  tier: MatchTier;
  coverage: number;
  indices: number[];
}

/** Detect if the prompt is in "feature argument" mode for a Kiro command. */
function detectFeatureArgMode(
  promptText: string,
  commands: CommandItem[],
): { commandName: string; query: string } | null {
  const spaceIdx = promptText.indexOf(" ");
  if (spaceIdx === -1 || !promptText.startsWith("/")) return null;

  const commandName = promptText.slice(0, spaceIdx);
  const command = commands.find((c) => c.name === commandName);
  if (!command?.argumentHint) return null;

  // Check if the command expects a feature-name argument
  if (!/feature-name/i.test(command.argumentHint)) return null;

  const query = promptText.slice(spaceIdx + 1);
  // Only show autocomplete for the first argument (no second space yet)
  if (query.includes(" ")) return null;

  return { commandName, query };
}

export interface CommandAutocompleteProps {
  promptText: string;
  onPromptChange: (text: string) => void;
  onPlaceholderChange: (placeholder: string) => void;
  projectName: string;
  /** When omitted, uses the project-level commands query instead of session-level */
  sessionName?: string;
  backend?: AgentBackendId;
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
    backend = "claude",
    disabled,
  },
  ref,
) {
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Fetch commands via TanStack Query — session-level when sessionName is provided,
  // otherwise project-level (e.g. in OptimisticDialog before a session exists)
  const sessionQuery = useCommandsQuery(
    projectName,
    sessionName ?? "",
    backend,
    {
      enabled: !!sessionName,
    },
  );
  const projectQuery = useProjectCommandsQuery(projectName, {
    enabled: !sessionName,
  });
  const commandsQuery = sessionName ? sessionQuery : projectQuery;
  const items = useMemo(
    () => commandsQuery.data?.items ?? [],
    [commandsQuery.data?.items],
  );

  // Mode detection: command mode vs feature argument mode
  const commandPrefix = backend === "codex" ? "$" : "/";
  const commandMode =
    !disabled &&
    promptText.startsWith(commandPrefix) &&
    !promptText.includes(" ");
  const featureArg = useMemo(
    () =>
      disabled || backend === "codex"
        ? null
        : detectFeatureArgMode(promptText, items),
    [backend, disabled, promptText, items],
  );
  const visible = commandMode || !!featureArg;
  const query = commandMode
    ? promptText.slice(commandPrefix.length)
    : (featureArg?.query ?? "");

  // Fetch Kiro features for feature argument mode
  const kiroDocTree = useKiroDocTreeQuery(projectName, sessionName, {
    enabled: !!featureArg,
  });
  const featureNames = useMemo(
    () => Object.keys(kiroDocTree.data?.specs ?? {}).sort(),
    [kiroDocTree.data?.specs],
  );

  const loading =
    (commandMode && commandsQuery.isPending) ||
    (!!featureArg && kiroDocTree.isPending);
  const error =
    commandMode && commandsQuery.isError
      ? (commandsQuery.error?.message ??
        (backend === "codex"
          ? "Failed to load skills"
          : "Failed to load commands"))
      : !!featureArg && kiroDocTree.isError
        ? (kiroDocTree.error?.message ?? "Failed to load features")
        : null;

  // Filter and score features (feature arg mode)
  const filteredFeatures = useMemo((): ScoredFeature[] => {
    if (!featureArg || featureNames.length === 0) return [];

    const results: ScoredFeature[] = [];
    for (const name of featureNames) {
      const result = fuzzyMatch(query, name);
      if (result.match) {
        results.push({
          name,
          tier: result.tier!,
          coverage: result.coverage,
          indices: result.indices,
        });
      }
    }

    results.sort(
      (a, b) => compareFuzzyResults(a, b) || a.name.localeCompare(b.name),
    );

    return results;
  }, [featureArg, featureNames, query]);

  // Filter and score commands (command mode)
  const filtered = useMemo((): ScoredItem[] => {
    if (!commandMode || items.length === 0) return [];

    const nameMatches: ScoredItem[] = [];
    const descMatches: ScoredItem[] = [];

    for (const item of items) {
      // Match against the item name without its leading trigger character
      const nameTarget = item.name.slice(1);
      const nameResult = fuzzyMatch(query, nameTarget);

      if (nameResult.match) {
        nameMatches.push({
          item,
          tier: nameResult.tier!,
          coverage: nameResult.coverage,
          // Shift indices by 1 to account for the leading trigger character
          nameIndices: nameResult.indices.map((i) => i + 1),
        });
        continue;
      }

      // Description matching only for queries >= 3 chars
      if (query.length >= 3) {
        const descResult = fuzzyMatch(query, item.description);
        if (descResult.match) {
          descMatches.push({
            item,
            tier: descResult.tier!,
            coverage: descResult.coverage,
            nameIndices: [],
          });
        }
      }
    }

    // Name matches always rank above description matches
    nameMatches.sort(
      (a, b) =>
        compareFuzzyResults(a, b) || a.item.name.localeCompare(b.item.name),
    );
    descMatches.sort(
      (a, b) =>
        compareFuzzyResults(a, b) || a.item.name.localeCompare(b.item.name),
    );

    const results: ScoredItem[] = [...nameMatches, ...descMatches];

    return results;
  }, [commandMode, items, query]);

  // Unified item count for keyboard navigation
  const totalItems = featureArg ? filteredFeatures.length : filtered.length;

  // Reset active index when filtered results change (state-during-render pattern)
  const resetKey = `${query}:${totalItems}:${featureArg ? "f" : "c"}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setActiveIndex(0);
  }

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

  // Select a feature (in feature argument mode)
  const selectFeature = useCallback(
    (feature: ScoredFeature) => {
      if (!featureArg) return;
      onPromptChange(featureArg.commandName + " " + feature.name + " ");
      onPlaceholderChange("");
    },
    [featureArg, onPromptChange, onPlaceholderChange],
  );

  // Keyboard handler - exposed to parent
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent): boolean => {
      if (!visible) return false;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, totalItems - 1));
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
          if (featureArg) {
            const selected = filteredFeatures[activeIndex];
            if (selected) selectFeature(selected);
          } else {
            const selected = filtered[activeIndex];
            if (selected) selectItem(selected);
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
    [
      visible,
      featureArg,
      filtered,
      filteredFeatures,
      totalItems,
      activeIndex,
      selectItem,
      selectFeature,
      onPromptChange,
    ],
  );

  // Expose handleKeyDown to parent via ref
  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  if (!visible) return null;

  // Render highlighted name
  function renderHighlighted(name: string, indices: number[]) {
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

  const headerLabel = featureArg
    ? "Features"
    : backend === "codex"
      ? "Skills"
      : "Commands";
  const emptyLabel = featureArg
    ? "No matching features"
    : backend === "codex"
      ? "No matching skills"
      : "No matching commands";
  const loadingLabel = featureArg
    ? "features"
    : backend === "codex"
      ? "skills"
      : "commands";

  return (
    <div className="cmd-autocomplete">
      <div className="cmd-header">
        <span>{headerLabel}</span>
        <span className="cmd-header-count">
          {totalItems} {totalItems === 1 ? "item" : "items"}
        </span>
      </div>

      <div className="cmd-list" ref={listRef}>
        {loading && (
          <div className="cmd-loading">Loading {loadingLabel}...</div>
        )}

        {error && (
          <div className="cmd-error">
            {error}. Press <kbd>/</kbd> to retry.
          </div>
        )}

        {!loading && !error && totalItems === 0 && (
          <div className="cmd-empty">{emptyLabel}</div>
        )}

        {/* Feature argument mode */}
        {!loading &&
          !error &&
          featureArg &&
          filteredFeatures.map((feature, i) => (
            <div
              key={feature.name}
              className={`cmd-item${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => selectFeature(feature)}
            >
              {renderHighlighted(feature.name, feature.indices)}
            </div>
          ))}

        {/* Command mode */}
        {!loading &&
          !error &&
          !featureArg &&
          filtered.map((scored, i) => (
            <div
              key={scored.item.name}
              className={`cmd-item${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => selectItem(scored)}
            >
              {renderHighlighted(scored.item.name, scored.nameIndices)}
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
