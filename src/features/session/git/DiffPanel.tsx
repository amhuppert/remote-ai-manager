"use client";

import { useState, useRef, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsTriggerCount,
} from "@/components/ui/Tabs";
import { EmptyStateTitle, EmptyStateDesc } from "@/components/ui/EmptyState";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";
import CommitHistory from "@/features/session/git/CommitHistory";
import {
  DIFF_FILE_SECTION_CLASS,
  DIFF_FILE_HEADER_CLASS,
  DIFF_FILE_NAME_CLASS,
  DIFF_FILE_STAT_CLASS,
  DIFF_LINE_BASE,
  DIFF_LINE_TYPE,
} from "@/features/session/git/diff-row-classes";
import { useAppHotkey } from "@/hooks/useAppHotkey";

type DiffTab = "uncommitted" | "commits";

const NAV_BTN_CLASS =
  "flex h-[28px] min-w-[28px] cursor-pointer items-center justify-center rounded-sm border border-solid border-border-default bg-transparent px-[6px] font-mono text-[0.75rem] font-medium text-text-secondary transition-all duration-150 ease-[ease] hover:border-border-strong hover:bg-bg-hover hover:text-text-primary hover:shadow-[0_0_8px_var(--color-cyan-glow)] [&_svg]:size-[16px] [&_svg]:shrink-0 max-768:h-[36px] max-768:min-h-[36px] max-768:min-w-[36px] max-768:px-xs max-768:[&_svg]:size-[14px]";
const TOOLBAR_GROUP_CLASS =
  "flex items-center gap-[3px] rounded-sm bg-[var(--cc-bg-base-a40)] p-[2px]";
const TOOLBAR_SEP_CLASS =
  "h-[20px] w-px shrink-0 bg-border-default mx-xs max-768:h-[16px]";

interface DiffPanelProps {
  diff: SessionDiff;
  commits?: CommitLogEntry[];
  projectName?: string;
  sessionName?: string;
  /** Branch this session merges into — used for diff label */
  targetBranch?: string;
  hotkeysEnabled?: boolean;
}

export default function DiffPanel({
  diff,
  commits = [],
  projectName = "",
  sessionName = "",
  targetBranch = "main",
  hotkeysEnabled = true,
}: DiffPanelProps): React.JSX.Element {
  const defaultTab: DiffTab = diff.files.length > 0 ? "uncommitted" : "commits";
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<number>>(new Set());
  const contentRef = useRef<HTMLDivElement>(null);
  const fileHeaderRefs = useRef<(HTMLDivElement | null)[]>([]);
  const hunkRefs = useRef<(HTMLDivElement | null)[]>([]);

  const toggleFile = useCallback((index: number) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsedFiles(new Set(diff.files.map((_, i) => i)));
  }, [diff.files]);

  const expandAll = useCallback(() => {
    setCollapsedFiles(new Set());
  }, []);

  const navigateFile = useCallback((dir: number) => {
    const headers = fileHeaderRefs.current.filter(Boolean);
    if (headers.length === 0) return;

    const container = contentRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const threshold = 4;

    let currentIdx = -1;
    for (let i = 0; i < headers.length; i++) {
      const el = headers[i];
      if (!el) continue;
      const top = el.offsetTop - container.offsetTop;
      if (top <= scrollTop + threshold) {
        currentIdx = i;
      }
    }

    let nextIdx = dir > 0 ? currentIdx + 1 : currentIdx - 1;
    nextIdx = Math.max(0, Math.min(headers.length - 1, nextIdx));

    // Auto-expand if collapsed
    setCollapsedFiles((prev) => {
      if (prev.has(nextIdx)) {
        const next = new Set(prev);
        next.delete(nextIdx);
        return next;
      }
      return prev;
    });

    headers[nextIdx]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const navigateHunk = useCallback((dir: number) => {
    const hunks = hunkRefs.current.filter(Boolean);
    if (hunks.length === 0) return;

    const container = contentRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const threshold = 4;

    let currentIdx = -1;
    for (let i = 0; i < hunks.length; i++) {
      const el = hunks[i];
      if (!el) continue;
      const top = el.offsetTop - container.offsetTop;
      if (top <= scrollTop + threshold) {
        currentIdx = i;
      }
    }

    let nextIdx = dir > 0 ? currentIdx + 1 : currentIdx - 1;
    nextIdx = Math.max(0, Math.min(hunks.length - 1, nextIdx));

    hunks[nextIdx]?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  useAppHotkey("nextFile", () => navigateFile(1), {
    enabled: hotkeysEnabled,
  });
  useAppHotkey("prevFile", () => navigateFile(-1), {
    enabled: hotkeysEnabled,
  });
  useAppHotkey("nextChange", () => navigateHunk(1), {
    enabled: hotkeysEnabled,
  });
  useAppHotkey("prevChange", () => navigateHunk(-1), {
    enabled: hotkeysEnabled,
  });

  // Build flat hunk ref index
  let hunkRefIndex = 0;

  return (
    <div className="sidebar-diff-panel flex-1">
      <div className="panel-header">
        <span className="panel-title">Diff vs {targetBranch}</span>
        <span className="font-mono text-[0.68rem] text-text-tertiary">
          <span className="text-green">+{diff.totalAdditions}</span>{" "}
          <span className="text-red">-{diff.totalDeletions}</span> &middot;{" "}
          {diff.files.length} file{diff.files.length !== 1 ? "s" : ""}
        </span>
      </div>

      <TabsRoot
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as DiffTab)}
        layoutClassName="flex min-h-0 flex-1 flex-col"
      >
        {/* Tab bar */}
        <div className="shrink-0 border-x-0 border-t-0 border-b border-solid border-border-subtle bg-[var(--cc-bg-surface-a30)] px-md py-sm">
          <TabsList>
            <TabsTrigger value="uncommitted">
              Uncommitted
              {diff.files.length > 0 && (
                <TabsTriggerCount>{diff.files.length}</TabsTriggerCount>
              )}
            </TabsTrigger>
            <TabsTrigger value="commits">
              Commits
              {commits.length > 0 && (
                <TabsTriggerCount>{commits.length}</TabsTriggerCount>
              )}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent
          value="uncommitted"
          layoutClassName="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex shrink-0 items-center gap-sm border-x-0 border-t-0 border-b border-solid border-border-subtle bg-bg-raised px-md py-sm max-768:flex-nowrap max-768:px-sm max-768:py-xs">
            <div className={TOOLBAR_GROUP_CLASS}>
              <button
                className={NAV_BTN_CLASS}
                onClick={collapseAll}
                title="Collapse all files"
              >
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <rect x="2" y="3" width="10" height="2" rx="0.5" />
                  <line x1="5" y1="8" x2="9" y2="8" />
                  <line x1="5" y1="11" x2="9" y2="11" />
                </svg>
              </button>
              <button
                className={NAV_BTN_CLASS}
                onClick={expandAll}
                title="Expand all files"
              >
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                >
                  <line x1="2" y1="3" x2="12" y2="3" />
                  <line x1="4" y1="5.5" x2="10" y2="5.5" />
                  <line x1="2" y1="8.5" x2="12" y2="8.5" />
                  <line x1="4" y1="11" x2="10" y2="11" />
                </svg>
              </button>
            </div>
            <div className={TOOLBAR_SEP_CLASS} />
            <div className={TOOLBAR_GROUP_CLASS}>
              <button
                className={NAV_BTN_CLASS}
                onClick={() => navigateFile(-1)}
              >
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9,2 5,7 9,12" />
                </svg>
              </button>
              <span className="mx-xs font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase max-768:hidden">
                Files
              </span>
              <button className={NAV_BTN_CLASS} onClick={() => navigateFile(1)}>
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="5,2 9,7 5,12" />
                </svg>
              </button>
            </div>
            <div className={TOOLBAR_SEP_CLASS} />
            <div className={TOOLBAR_GROUP_CLASS}>
              <button
                className={NAV_BTN_CLASS}
                onClick={() => navigateHunk(-1)}
              >
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9,2 5,7 9,12" />
                </svg>
              </button>
              <span className="mx-xs font-mono text-[0.7rem] font-semibold tracking-[0.06em] text-text-secondary uppercase max-768:hidden">
                Changes
              </span>
              <button className={NAV_BTN_CLASS} onClick={() => navigateHunk(1)}>
                <svg
                  viewBox="0 0 14 14"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="5,2 9,7 5,12" />
                </svg>
              </button>
            </div>
          </div>

          <div
            className="flex-1 overflow-auto p-0 font-mono text-[0.75rem] leading-[1.7]"
            ref={contentRef}
          >
            {diff.files.length === 0 ? (
              // Legacy `.empty-state` flattened its `3xl xl` padding to a flat
              // `var(--space-xl)` via inline style; the EmptyState primitive's
              // baked `px-xl py-3xl` cannot reproduce that, so the container is
              // inlined with the effective `px-xl py-xl` utilities (mirroring
              // SessionDiffViewer) while title/desc use the family primitives.
              <div className="flex flex-col items-center justify-center px-xl py-xl text-center">
                <EmptyStateTitle>No changes</EmptyStateTitle>
                <EmptyStateDesc>
                  This session has no uncommitted changes.
                </EmptyStateDesc>
              </div>
            ) : (
              diff.files.map((file, fileIdx) => {
                const isCollapsed = collapsedFiles.has(fileIdx);
                return (
                  <div key={file.filePath} className={DIFF_FILE_SECTION_CLASS}>
                    <div
                      ref={(el) => {
                        fileHeaderRefs.current[fileIdx] = el;
                      }}
                      data-collapsed={isCollapsed}
                      className={cn(DIFF_FILE_HEADER_CLASS, "group/dfh")}
                      onClick={() => toggleFile(fileIdx)}
                    >
                      <span className="shrink-0 text-[0.7rem] leading-none text-text-tertiary transition-transform duration-150 ease-[ease] group-data-[collapsed=true]/dfh:-rotate-90">
                        &#9662;
                      </span>
                      <span className={DIFF_FILE_NAME_CLASS}>
                        {file.filePath}
                      </span>
                      <span className={DIFF_FILE_STAT_CLASS}>
                        <span className="text-green">+{file.additions}</span>{" "}
                        <span className="text-red">-{file.deletions}</span>
                      </span>
                    </div>
                    <div className={cn("min-w-fit", isCollapsed && "hidden")}>
                      {file.hunks.map((hunk, hunkIdx) => {
                        const currentHunkRefIdx = hunkRefIndex++;
                        return (
                          <div key={hunkIdx}>
                            {hunk.lines.map((line, lineIdx) => {
                              if (line.type === "hunk-header") {
                                return (
                                  <div
                                    key={lineIdx}
                                    ref={(el) => {
                                      hunkRefs.current[currentHunkRefIdx] = el;
                                    }}
                                    className={cn(
                                      DIFF_LINE_BASE,
                                      DIFF_LINE_TYPE["hunk-header"],
                                    )}
                                  >
                                    {line.content}
                                  </div>
                                );
                              }
                              return (
                                <div
                                  key={lineIdx}
                                  className={cn(
                                    DIFF_LINE_BASE,
                                    DIFF_LINE_TYPE[line.type],
                                  )}
                                >
                                  {line.content}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </TabsContent>

        <TabsContent
          value="commits"
          layoutClassName="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex-1 overflow-auto p-0 font-mono text-[0.75rem] leading-[1.7]">
            <CommitHistory
              commits={commits}
              projectName={projectName}
              sessionName={sessionName}
            />
          </div>
        </TabsContent>
      </TabsRoot>
    </div>
  );
}
