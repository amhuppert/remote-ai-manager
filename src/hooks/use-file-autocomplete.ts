"use client";

import { useMemo, useRef, useCallback, useState } from "react";
import { useProjectFilesQuery } from "@/lib/queries";
import { detectFileAutocompleteTrigger } from "@/lib/file-autocomplete-trigger";
import {
  filterAndScoreFiles,
  type ScoredFileItem,
} from "@/lib/file-autocomplete-filter";
import type { FileAutocompleteHandle } from "@/components/FileAutocomplete";

interface UseFileAutocompleteOptions {
  projectName: string;
  /** When provided, files are sourced from the session worktree, not the project root. */
  sessionName?: string;
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
  /** True when the underlying scan was truncated by the server */
  truncated: boolean;
  /** Handle file selection — replaces @query with @path */
  onSelect: (path: string) => void;
  /** Close the dropdown */
  onClose: () => void;
  /** Update cursor position — call from textarea onSelect/onClick */
  updateCursor: (pos: number) => void;
}

export function useFileAutocomplete({
  projectName,
  sessionName,
  text,
  cursorPosition,
  disabled = false,
  onTextChange,
}: UseFileAutocompleteOptions): UseFileAutocompleteReturn {
  const autocompleteRef = useRef<FileAutocompleteHandle>(null);
  const [dismissed, setDismissed] = useState(false);
  const [prevTriggerKey, setPrevTriggerKey] = useState<string | null>(null);

  const trigger = useMemo(
    () =>
      disabled ? null : detectFileAutocompleteTrigger(text, cursorPosition),
    [text, cursorPosition, disabled],
  );

  const triggerKey = trigger ? `${trigger.startIndex}` : null;
  if (triggerKey !== prevTriggerKey) {
    setPrevTriggerKey(triggerKey);
    if (triggerKey !== null) {
      setDismissed(false);
    }
  }

  const visible = trigger !== null && !dismissed;

  const filesQuery = useProjectFilesQuery(
    { projectName, sessionName },
    { enabled: visible },
  );

  const loading = filesQuery.isLoading && visible;
  const error = filesQuery.error ? filesQuery.error.message : null;
  const truncated = filesQuery.data?.truncated ?? false;

  const { items, totalCount } = useMemo(() => {
    if (!trigger || !filesQuery.data?.items) {
      return { items: [] as ScoredFileItem[], totalCount: 0 };
    }
    return filterAndScoreFiles(trigger.query, filesQuery.data.items);
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
    truncated,
    onSelect,
    onClose,
    updateCursor,
  };
}
