"use client";

import { useMemo, useRef, useCallback, useState } from "react";
import { useProjectFilesQuery } from "@/lib/queries";
import { detectFileAutocompleteTrigger } from "@/lib/file-autocomplete-trigger";
import { fuzzyMatch, compareFuzzyResults } from "@/lib/fuzzy";
import type {
  ScoredFileItem,
  FileAutocompleteHandle,
} from "@/components/FileAutocomplete";

const MAX_DISPLAY_ITEMS = 50;

interface UseFileAutocompleteOptions {
  projectName: string;
  text: string;
  cursorPosition: number;
  disabled?: boolean;
  onTextChange: (text: string) => void;
}

interface UseFileAutocompleteReturn {
  /** Ref to attach to the FileAutocomplete component */
  autocompleteRef: React.RefObject<FileAutocompleteHandle | null>;
  /** Whether the dropdown should be visible */
  visible: boolean;
  /** Filtered and scored items to display */
  items: ScoredFileItem[];
  /** Total number of matches before capping */
  totalCount: number;
  /** Whether files are loading */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Handle file selection — replaces @query with @path */
  onSelect: (path: string) => void;
  /** Close the dropdown */
  onClose: () => void;
  /** Update cursor position — call from textarea onSelect/onClick */
  updateCursor: (pos: number) => void;
}

export function useFileAutocomplete({
  projectName,
  text,
  cursorPosition,
  disabled = false,
  onTextChange,
}: UseFileAutocompleteOptions): UseFileAutocompleteReturn {
  const autocompleteRef = useRef<FileAutocompleteHandle>(null);
  const [dismissed, setDismissed] = useState(false);
  const [prevTriggerKey, setPrevTriggerKey] = useState<string | null>(null);

  // Detect @-trigger
  const trigger = useMemo(
    () =>
      disabled ? null : detectFileAutocompleteTrigger(text, cursorPosition),
    [text, cursorPosition, disabled],
  );

  // Reset dismissed state when trigger changes
  const triggerKey = trigger ? `${trigger.startIndex}` : null;
  if (triggerKey !== prevTriggerKey) {
    setPrevTriggerKey(triggerKey);
    if (triggerKey !== null) {
      setDismissed(false);
    }
  }

  const visible = trigger !== null && !dismissed;

  // Fetch project files
  const filesQuery = useProjectFilesQuery(projectName, {
    enabled: visible,
  });

  const loading = filesQuery.isLoading && visible;
  const error = filesQuery.error ? filesQuery.error.message : null;

  // Fuzzy filter files
  const { items, totalCount } = useMemo(() => {
    if (!trigger || !filesQuery.data?.items) {
      return { items: [] as ScoredFileItem[], totalCount: 0 };
    }

    const query = trigger.query;
    const scored: ScoredFileItem[] = [];

    for (const file of filesQuery.data.items) {
      const result = fuzzyMatch(query, file.path);
      if (result.match) {
        scored.push({
          item: file,
          tier: result.tier!,
          coverage: result.coverage,
          indices: result.indices,
        });
      }
    }

    scored.sort(
      (a, b) =>
        compareFuzzyResults(a, b) || a.item.path.localeCompare(b.item.path),
    );

    const total = scored.length;
    return {
      items: scored.slice(0, MAX_DISPLAY_ITEMS),
      totalCount: total,
    };
  }, [trigger, filesQuery.data]);

  const onSelect = useCallback(
    (path: string) => {
      if (!trigger) return;
      const before = text.slice(0, trigger.startIndex);
      const after = text.slice(trigger.endIndex);
      const newText = `${before}@${path} ${after}`;
      onTextChange(newText);
      setDismissed(true);
    },
    [trigger, text, onTextChange],
  );

  const onClose = useCallback(() => {
    setDismissed(true);
  }, []);

  const updateCursor = useCallback(() => {
    // Cursor position is tracked via the cursorPosition prop
    // This is a no-op placeholder for future cursor tracking needs
  }, []);

  return {
    autocompleteRef,
    visible,
    items,
    totalCount,
    loading,
    error,
    onSelect,
    onClose,
    updateCursor,
  };
}
