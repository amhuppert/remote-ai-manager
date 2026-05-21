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
import { useProjectFilesQuery } from "@/lib/queries";
import { filterAndScoreFiles } from "@/lib/file-autocomplete-filter";

export interface FileMentionPopupHandle {
  /** Forward a keydown event from the editor; returns true when consumed. */
  handleKeyDown: (event: KeyboardEvent) => boolean;
}

export interface FileMentionSelection {
  path: string;
  basename: string;
  ext: string;
}

export interface FileMentionPopupProps {
  /** Text typed after `@` (without the leading `@`). */
  query: string;
  projectName: string;
  sessionName: string;
  /** Insert the chosen file into the editor at the trigger range. */
  onSelect: (selection: FileMentionSelection) => void;
}

function deriveBasenameAndExt(path: string): { basename: string; ext: string } {
  const slash = path.lastIndexOf("/");
  const basename = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = basename.lastIndexOf(".");
  const ext = dot > 0 ? basename.slice(dot + 1) : "";
  return { basename, ext };
}

export const PromptEditorFileMentionPopup = forwardRef<
  FileMentionPopupHandle,
  FileMentionPopupProps
>(function PromptEditorFileMentionPopup(
  { query, projectName, sessionName, onSelect },
  ref,
) {
  const filesQuery = useProjectFilesQuery({ projectName, sessionName });

  const { display, totalCount, truncated } = useMemo(() => {
    const files = filesQuery.data?.items ?? [];
    const result = filterAndScoreFiles(query, files);
    return {
      display: result.items,
      totalCount: result.totalCount,
      truncated: filesQuery.data?.truncated ?? false,
    };
  }, [filesQuery.data, query]);

  const listItems = useMemo<FileAutocompleteListItem[]>(
    () =>
      display.map((s) => ({
        id: s.item.path,
        path: s.item.path,
        matchIndices: s.indices,
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
      const { basename, ext } = deriveBasenameAndExt(target.item.path);
      onSelect({ path: target.item.path, basename, ext });
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
      truncated={truncated}
    />
  );
});
