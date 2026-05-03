"use client";

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FileAutocompleteList,
  type FileAutocompleteListItem,
} from "@/components/FileAutocompleteList";
import { fuzzyMatch, compareFuzzyResults, type MatchTier } from "@/lib/fuzzy";
import { useProjectFilesQuery } from "@/lib/queries";

const MAX_DISPLAY_ITEMS = 50;

export interface FileMentionPopupHandle {
  /** Forward a keydown event from the editor; returns true when consumed. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export interface FileMentionPopupProps {
  /** Text typed after `@` (without the leading `@`). */
  query: string;
  projectName: string;
  /** Insert the chosen path into the editor at the trigger range. */
  onSelect: (path: string) => void;
}

interface ScoredFile {
  path: string;
  tier: MatchTier;
  coverage: number;
  matchIndices: number[];
}

export const PromptEditorFileMentionPopup = forwardRef<
  FileMentionPopupHandle,
  FileMentionPopupProps
>(function PromptEditorFileMentionPopup({ query, projectName, onSelect }, ref) {
  const filesQuery = useProjectFilesQuery(projectName);

  const { display, totalCount } = useMemo(() => {
    const files = filesQuery.data?.items ?? [];
    if (files.length === 0)
      return { display: [] as ScoredFile[], totalCount: 0 };

    const scored: ScoredFile[] = [];
    for (const file of files) {
      const result = fuzzyMatch(query, file.path);
      if (result.match) {
        scored.push({
          path: file.path,
          tier: result.tier!,
          coverage: result.coverage,
          matchIndices: result.indices,
        });
      }
    }
    scored.sort(
      (a, b) => compareFuzzyResults(a, b) || a.path.localeCompare(b.path),
    );
    return {
      display: scored.slice(0, MAX_DISPLAY_ITEMS),
      totalCount: scored.length,
    };
  }, [filesQuery.data, query]);

  const listItems = useMemo<FileAutocompleteListItem[]>(
    () =>
      display.map((s) => ({
        id: s.path,
        path: s.path,
        matchIndices: s.matchIndices,
      })),
    [display],
  );

  const [activeIndex, setActiveIndex] = useState(0);
  const resetKey = `${query}:${listItems.length}`;
  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (resetKey !== prevResetKey) {
    setPrevResetKey(resetKey);
    setActiveIndex(0);
  }

  const activeIndexRef = useRef(activeIndex);
  const displayRef = useRef(display);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);
  useEffect(() => {
    displayRef.current = display;
  }, [display]);

  const selectAt = useCallback(
    (index: number) => {
      const target = displayRef.current[index];
      if (!target) return;
      onSelect(target.path);
    },
    [onSelect],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const total = displayRef.current.length;
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          setActiveIndex((prev) => Math.min(prev + 1, Math.max(total - 1, 0)));
          return true;
        }
        case "ArrowUp": {
          event.preventDefault();
          setActiveIndex((prev) => Math.max(prev - 1, 0));
          return true;
        }
        case "Enter":
        case "Tab": {
          if (total === 0) return false;
          event.preventDefault();
          selectAt(activeIndexRef.current);
          return true;
        }
        default:
          return false;
      }
    },
    [selectAt],
  );

  useImperativeHandle(ref, () => ({ handleKeyDown }), [handleKeyDown]);

  const error = filesQuery.isError
    ? (filesQuery.error?.message ?? "Failed to load files")
    : null;

  return (
    <FileAutocompleteList
      items={listItems}
      selectedIndex={activeIndex}
      onHover={setActiveIndex}
      onSelect={(item) => {
        const idx = listItems.findIndex((i) => i.id === item.id);
        if (idx >= 0) selectAt(idx);
      }}
      totalCount={totalCount}
      loading={filesQuery.isLoading}
      error={error}
    />
  );
});
