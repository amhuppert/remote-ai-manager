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
import { useProjectFilesQuery } from "@/lib/files/queries";
import { filterAndScoreFiles } from "@/lib/files/file-autocomplete-filter";
import { isMarkdownPath } from "@/lib/documents/path";
import { useOpenDocument } from "@/stores/session-detail.store";
import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";

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
  /**
   * Explicit scope (D1). A discriminated union rather than an optional
   * `sessionName`, because "undefined means project" silently reads a
   * sentinel-valued session name as a real session (R1.3).
   */
  scopeRef: ConversationScopeRef;
  /** Insert the chosen file into the editor at the trigger range. */
  onSelect: (selection: FileMentionSelection) => void;
  /** Dismiss the popup (Escape). Host should clear its suggestion state. */
  onClose?: () => void;
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
  { query, projectName, scopeRef, onSelect, onClose },
  ref,
) {
  const openDocument = useOpenDocument();
  const projectLevel = scopeRef.scope === "project";
  // Project conversations scan the project root; sessions scan their worktree.
  const filesQuery = useProjectFilesQuery(
    scopeRef.scope === "project"
      ? { projectName }
      : { projectName, sessionName: scopeRef.sessionName },
  );

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
        openable: !projectLevel && isMarkdownPath(s.item.path),
      })),
    [display, projectLevel],
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

  const openAt = useCallback(
    (index: number) => {
      const target = displayRef.current[index];
      if (!target || !isMarkdownPath(target.item.path)) return;
      // The document viewer is a session capability; project conversations have
      // no session to open a document against.
      if (scopeRef.scope !== "session") return;
      const { basename } = deriveBasenameAndExt(target.item.path);
      openDocument({
        projectName,
        sessionName: scopeRef.sessionName,
        docPath: target.item.path,
        title: basename,
      });
      onClose?.();
    },
    [onClose, openDocument, projectName, scopeRef],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent): boolean => {
      const total = displayRef.current.length;
      if (event.altKey && event.key === "Enter") {
        const target = displayRef.current[activeIndexRef.current];
        if (!target || !isMarkdownPath(target.item.path) || projectLevel) {
          return false;
        }
        event.preventDefault();
        openAt(activeIndexRef.current);
        return true;
      }
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
        case "Escape": {
          event.preventDefault();
          event.stopPropagation();
          onClose?.();
          return true;
        }
        default:
          return false;
      }
    },
    [selectAt, openAt, onClose, projectLevel],
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
      onOpen={(item) => {
        const idx = listItems.findIndex(
          (candidate) => candidate.id === item.id,
        );
        if (idx >= 0) openAt(idx);
      }}
      totalCount={totalCount}
      loading={filesQuery.isLoading}
      error={error}
      truncated={truncated}
    />
  );
});
