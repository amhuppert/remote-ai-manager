"use client";

import "../styles/session-diff.css";
import { useState, useRef, useCallback } from "react";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";
import {
  useSessionDiffQuery,
  useCommitsQuery,
  useCommitDiffQuery,
} from "@/lib/git/queries";
import { useSessionQuery } from "@/lib/sessions/queries";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import { cn } from "@/lib/ui/cn";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsTriggerCount,
  TabsContent,
} from "@/components/ui/Tabs";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/Accordion";
import {
  EmptyState,
  EmptyStateTitle,
  EmptyStateDesc,
} from "@/components/ui/EmptyState";
import { Button } from "@/components/ui/Button";
import Topbar from "@/components/Topbar";

type DiffTab = "uncommitted" | "commits";

interface Props {
  projectName: string;
  sessionName: string;
}

/* ── Migrated utility recipes (value-identical to the legacy BEM rules in
   session.css / conversation.css / session-diff.css; the rule bodies are left
   in place for Stage B-3 cleanup). ── */

const diffFileSection =
  "border-b border-border-subtle min-w-fit last:border-b-0";

const diffFileHeaderBase =
  "sticky top-0 z-raised px-md py-sm bg-bg-raised border-b border-border-subtle font-semibold text-text-secondary text-[0.72rem] flex items-center gap-[6px] cursor-pointer select-none transition-[background] duration-100 ease-[ease] hover:bg-bg-hover max-768:px-sm max-768:py-xs max-768:text-[0.7rem]";

const diffFileChevron =
  "text-[0.7rem] transition-transform duration-150 ease-[ease] text-text-tertiary shrink-0 leading-none";

const diffFileName =
  "flex-1 whitespace-nowrap overflow-hidden text-ellipsis max-768:min-w-0";

const diffFileStat = "text-[0.7rem] font-normal shrink-0";

const diffFileLinesBase = "min-w-fit";

const diffLineBase =
  "px-md whitespace-pre border-l-[3px] border-l-transparent max-768:px-sm";

const diffLineByType: Record<
  "add" | "remove" | "context" | "hunk-header",
  string
> = {
  add: "bg-[var(--cc-green-a06)] border-l-green text-green",
  remove: "bg-[var(--cc-red-a06)] border-l-red text-red",
  context: "text-text-tertiary",
  "hunk-header": "text-cyan-dim bg-cyan-glow font-medium",
};

const diffContent =
  "flex-1 overflow-auto p-0 font-mono text-[0.75rem] leading-[1.7]";

/* ── Inline commit entry with lazy-loaded diff ── */

function CommitEntry({
  commit,
  isExpanded,
  projectName,
  sessionName,
}: {
  commit: CommitLogEntry;
  isExpanded: boolean;
  projectName: string;
  sessionName: string;
}) {
  const diffQuery = useCommitDiffQuery(
    projectName,
    sessionName,
    isExpanded ? commit.fullHash : null,
  );

  return (
    <AccordionItem value={commit.fullHash} asChild>
      <div
        className={cn(
          // base entry + bottom divider
          "relative border-b border-border-subtle last:border-b-0",
          // ::before — continuous timeline rail
          "before:absolute before:top-0 before:bottom-0 before:left-[18px] before:z-base before:w-px before:bg-border-default before:content-['']",
          "first:before:top-1/2 last:before:bottom-1/2",
          // ::after — timeline node dot
          "after:absolute after:top-1/2 after:left-[14px] after:z-raised after:h-[9px] after:w-[9px] after:-translate-y-1/2 after:rounded-full after:border-2 after:border-border-strong after:bg-bg-surface after:transition-[all] after:duration-200 after:ease-[ease] after:content-['']",
          // expanded-state rail, driven by the isExpanded prop (kept in sync with
          // the accordion's open value)
          isExpanded &&
            "before:top-0 after:top-[20px] after:translate-y-0 after:border-cyan-dim after:bg-cyan-glow after:shadow-[0_0_6px_var(--cyan-glow-strong)] first:before:top-[20px]",
        )}
      >
        <AccordionTrigger asChild>
          <button
            type="button"
            // The old clickable `<div>` inherited the page font (15px / 1.5
            // line-height); a bare `<button>` instead picks up the UA default
            // (Preflight is off), which shrinks the auto-sized grid rows and
            // shifts the metadata baseline. Pin the div's exact font context.
            className={cn(
              "group/hdr relative z-raised grid w-full cursor-pointer grid-cols-[auto_1fr] grid-rows-[auto_auto] items-center gap-x-[8px] gap-y-[2px] border-0 bg-transparent pt-[10px] pr-md pb-[10px] pl-[32px] text-left text-[15px] leading-[1.5] transition-[background] duration-150 ease-[ease] outline-none select-none hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] active:bg-[var(--cc-bg-hover-a80)]",
              "data-[state=open]:border-b data-[state=open]:border-border-subtle data-[state=open]:bg-[var(--cc-cyan-a04)]",
            )}
          >
            <span
              className={cn(
                "col-start-1 row-start-1 w-fit rounded-[3px] border border-[var(--cc-cyan-a12)] bg-[var(--cc-cyan-a07)] px-[6px] py-px font-mono text-[0.7rem] font-semibold tracking-[0.03em] text-cyan-dim transition-[all] duration-200 ease-[ease]",
                isExpanded
                  ? "border-cyan-glow-strong bg-cyan-glow text-cyan shadow-[0_0_8px_var(--cc-cyan-a10)]"
                  : "group-hover/hdr:border-[var(--cc-cyan-a25)] group-hover/hdr:bg-cyan-glow group-hover/hdr:text-cyan",
              )}
            >
              {commit.hash}
            </span>
            <span className="col-start-2 row-start-1 overflow-hidden font-body text-[0.78rem] leading-[1.3] font-medium text-ellipsis whitespace-nowrap text-text-primary">
              {commit.message}
            </span>
            <span className="col-[1/3] row-start-2 flex items-center gap-sm pt-px font-mono text-[0.7rem] text-text-tertiary">
              <span className="flex items-center gap-[3px] after:ml-[4px] after:opacity-40 after:content-['\00b7']">
                {commit.filesChanged} file
                {commit.filesChanged !== 1 ? "s" : ""}
              </span>
              <span className="opacity-70">
                {formatRelativeTime(commit.date)}
              </span>
            </span>
          </button>
        </AccordionTrigger>

        <AccordionContent asChild>
          <div className="relative ml-[32px] border-l border-border-subtle bg-[var(--cc-bg-void-a30)] font-mono text-[0.75rem] leading-[1.7]">
            {diffQuery.isPending ? (
              <div className={commitDiffLoading}>Loading diff...</div>
            ) : diffQuery.data ? (
              diffQuery.data.files.map((file) => (
                <div
                  key={file.filePath}
                  className={cn(diffFileSection, "last:border-b-0")}
                >
                  <div className={diffFileHeaderBase}>
                    <span className={diffFileName}>{file.filePath}</span>
                    <span className={diffFileStat}>
                      <span className="text-green">+{file.additions}</span>{" "}
                      <span className="text-red">-{file.deletions}</span>
                    </span>
                  </div>
                  <div className={diffFileLinesBase}>
                    {file.hunks.map((hunk, hunkIdx) => (
                      <div key={hunkIdx}>
                        {hunk.lines.map((line, lineIdx) => (
                          <div
                            key={lineIdx}
                            className={cn(
                              diffLineBase,
                              diffLineByType[line.type],
                            )}
                          >
                            {line.content}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <div className={commitDiffLoading}>Failed to load diff.</div>
            )}
          </div>
        </AccordionContent>
      </div>
    </AccordionItem>
  );
}

const commitDiffLoading =
  "px-md py-lg text-text-tertiary font-mono text-[0.72rem] flex items-center gap-sm before:content-[''] before:w-[16px] before:h-[16px] before:border-2 before:border-border-default before:border-t-cyan-dim before:rounded-full before:animate-[spin_0.7s_linear_infinite]";

/* ── Uncommitted diff content with navigation ── */

function UncommittedDiff({
  diff,
  hotkeysEnabled,
}: {
  diff: SessionDiff;
  hotkeysEnabled: boolean;
}) {
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
    <>
      <div className="flex shrink-0 items-center gap-sm border-b border-border-subtle bg-bg-raised px-md py-sm max-768:flex-nowrap max-768:px-sm max-768:py-xs">
        <div className={diffToolbarGroup}>
          <button
            className={diffNavBtn}
            onClick={collapseAll}
            title="Collapse all files"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className={diffNavBtnSvg}
            >
              <rect x="2" y="3" width="10" height="2" rx="0.5" />
              <line x1="5" y1="8" x2="9" y2="8" />
              <line x1="5" y1="11" x2="9" y2="11" />
            </svg>
          </button>
          <button
            className={diffNavBtn}
            onClick={expandAll}
            title="Expand all files"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              className={diffNavBtnSvg}
            >
              <line x1="2" y1="3" x2="12" y2="3" />
              <line x1="4" y1="5.5" x2="10" y2="5.5" />
              <line x1="2" y1="8.5" x2="12" y2="8.5" />
              <line x1="4" y1="11" x2="10" y2="11" />
            </svg>
          </button>
        </div>
        <div className={diffToolbarSep} />
        <div className={diffToolbarGroup}>
          <button
            className={diffNavBtn}
            onClick={() => navigateFile(-1)}
            title="Previous file"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={diffNavBtnSvg}
            >
              <polyline points="9,2 5,7 9,12" />
            </svg>
          </button>
          <span className={diffToolbarLabel}>Files</span>
          <button
            className={diffNavBtn}
            onClick={() => navigateFile(1)}
            title="Next file"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={diffNavBtnSvg}
            >
              <polyline points="5,2 9,7 5,12" />
            </svg>
          </button>
        </div>
        <div className={diffToolbarSep} />
        <div className={diffToolbarGroup}>
          <button
            className={diffNavBtn}
            onClick={() => navigateHunk(-1)}
            title="Previous change"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={diffNavBtnSvg}
            >
              <polyline points="9,2 5,7 9,12" />
            </svg>
          </button>
          <span className={diffToolbarLabel}>Changes</span>
          <button
            className={diffNavBtn}
            onClick={() => navigateHunk(1)}
            title="Next change"
          >
            <svg
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={diffNavBtnSvg}
            >
              <polyline points="5,2 9,7 5,12" />
            </svg>
          </button>
        </div>
      </div>

      <div className={diffContent} ref={contentRef}>
        {diff.files.length === 0 ? (
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
              <div key={file.filePath} className={diffFileSection}>
                <div
                  ref={(el) => {
                    fileHeaderRefs.current[fileIdx] = el;
                  }}
                  className={diffFileHeaderBase}
                  onClick={() => toggleFile(fileIdx)}
                >
                  <span
                    className={cn(
                      diffFileChevron,
                      isCollapsed && "rotate-[-90deg]",
                    )}
                  >
                    &#9662;
                  </span>
                  <span className={diffFileName}>{file.filePath}</span>
                  <span className={diffFileStat}>
                    <span className="text-green">+{file.additions}</span>{" "}
                    <span className="text-red">-{file.deletions}</span>
                  </span>
                </div>
                <div className={cn(diffFileLinesBase, isCollapsed && "hidden")}>
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
                                  diffLineBase,
                                  diffLineByType["hunk-header"],
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
                                diffLineBase,
                                diffLineByType[line.type],
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
    </>
  );
}

const diffToolbarGroup =
  "flex items-center gap-[3px] p-[2px] bg-[var(--cc-bg-base-a40)] rounded-sm";

const diffToolbarSep =
  "w-px h-[20px] bg-border-default shrink-0 mx-xs max-768:h-[16px]";

const diffToolbarLabel =
  "font-mono text-[0.7rem] font-semibold uppercase tracking-[0.06em] text-text-secondary mx-xs max-768:hidden";

const diffNavBtn =
  "flex items-center justify-center min-w-[28px] h-[28px] px-[6px] border border-border-default rounded-sm bg-transparent text-text-secondary font-mono text-[0.75rem] font-medium transition-[all] duration-150 ease-[ease] cursor-pointer hover:bg-bg-hover hover:text-text-primary hover:border-border-strong hover:shadow-[0_0_8px_var(--cyan-glow)] max-768:min-w-[36px] max-768:min-h-[36px] max-768:h-[36px] max-768:px-xs";

const diffNavBtnSvg =
  "w-[16px] h-[16px] shrink-0 max-768:w-[14px] max-768:h-[14px]";

/* ── Main SessionDiffViewer page component ── */

export default function SessionDiffViewer({
  projectName,
  sessionName,
}: Props): React.JSX.Element {
  const sessionQuery = useSessionQuery(projectName, sessionName);
  const session = sessionQuery.data;

  const targetBranch = session?.targetBranch ?? "main";

  const diffQuery = useSessionDiffQuery(projectName, sessionName);
  const commitsQuery = useCommitsQuery(projectName, sessionName);
  const isRefreshing = diffQuery.isFetching || commitsQuery.isFetching;
  const handleRefresh = useCallback(() => {
    void diffQuery.refetch();
    void commitsQuery.refetch();
  }, [diffQuery, commitsQuery]);

  const diff = diffQuery.data ?? {
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
  const commits = commitsQuery.data ?? [];

  const defaultTab: DiffTab = diff.files.length > 0 ? "uncommitted" : "commits";
  const [activeTab, setActiveTab] = useState<DiffTab>(defaultTab);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  const decodedProjectName = decodeURIComponent(projectName);

  const isLoading = sessionQuery.isPending;

  if (isLoading) {
    return (
      <div className="app" data-page="session-diff">
        <Topbar
          page="detail"
          breadcrumbs={[
            { label: "projects", href: "/projects" },
            {
              label: decodedProjectName,
              href: `/projects/${encodeURIComponent(projectName)}`,
            },
            {
              label: sessionName,
              href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
              isSession: true,
            },
            { label: "Diff" },
          ]}
        />
        <main className="main">
          <EmptyState>
            <EmptyStateTitle>Loading diff...</EmptyStateTitle>
          </EmptyState>
        </main>
      </div>
    );
  }

  return (
    <div className="app" data-page="session-diff">
      <Topbar
        page="detail"
        breadcrumbs={[
          { label: "projects", href: "/projects" },
          {
            label: decodedProjectName,
            href: `/projects/${encodeURIComponent(projectName)}`,
          },
          {
            label: sessionName,
            href: `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}`,
            isSession: true,
          },
          { label: "Diff" },
        ]}
      />

      <main className="main">
        <div className="stagger-in mx-auto flex h-full min-h-0 w-full max-w-[1200px] flex-col p-lg max-768:p-sm">
          <div className="flex max-h-[calc(100dvh-120px)] min-h-0 flex-1 flex-col overflow-clip rounded-none border-0 border-l border-border-default bg-bg-base max-768:max-h-[calc(100dvh-100px)] max-768:rounded-none max-768:border-r-0 max-768:border-l-0">
            <div className="flex items-center gap-sm border-b border-border-subtle bg-transparent px-lg py-md max-768:flex-wrap max-768:gap-xs max-768:px-sm max-768:py-xs">
              <span className="font-mono text-[0.72rem] font-semibold tracking-[0.08em] text-text-secondary uppercase">
                Diff vs {targetBranch}
              </span>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "0.68rem",
                  color: "var(--text-tertiary)",
                }}
              >
                <span style={{ color: "var(--green)" }}>
                  +{diff.totalAdditions}
                </span>{" "}
                <span style={{ color: "var(--red)" }}>
                  -{diff.totalDeletions}
                </span>{" "}
                &middot; {diff.files.length} file
                {diff.files.length !== 1 ? "s" : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                layoutClassName="ml-auto"
                onClick={handleRefresh}
                disabled={isRefreshing}
                aria-label="Refresh"
                type="button"
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </div>

            <TabsRoot
              value={activeTab}
              onValueChange={(v) => setActiveTab(v as DiffTab)}
              layoutClassName="flex min-h-0 flex-1 flex-col"
            >
              {/* Tab bar */}
              <div className="shrink-0 border-b border-border-subtle bg-[var(--cc-bg-surface-a30)] px-md py-sm">
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
                <UncommittedDiff
                  diff={diff}
                  hotkeysEnabled={activeTab === "uncommitted"}
                />
              </TabsContent>

              <TabsContent
                value="commits"
                layoutClassName="flex min-h-0 flex-1 flex-col"
              >
                <div className={diffContent}>
                  {commits.length === 0 ? (
                    <div className="flex flex-col items-center justify-center px-xl py-xl text-center">
                      <EmptyStateTitle>No commits</EmptyStateTitle>
                      <EmptyStateDesc>
                        Commit changes to see them listed here.
                      </EmptyStateDesc>
                    </div>
                  ) : (
                    <Accordion
                      type="single"
                      collapsible
                      value={expandedHash ?? ""}
                      onValueChange={(value) =>
                        setExpandedHash(value === "" ? null : value)
                      }
                      asChild
                    >
                      <div className="px-0 py-sm">
                        {commits.map((commit) => (
                          <CommitEntry
                            key={commit.fullHash}
                            commit={commit}
                            isExpanded={expandedHash === commit.fullHash}
                            projectName={projectName}
                            sessionName={sessionName}
                          />
                        ))}
                      </div>
                    </Accordion>
                  )}
                </div>
              </TabsContent>
            </TabsRoot>
          </div>
        </div>
      </main>
    </div>
  );
}
