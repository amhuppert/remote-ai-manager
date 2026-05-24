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
import Topbar from "@/components/Topbar";

type DiffTab = "uncommitted" | "commits";

interface Props {
  projectName: string;
  sessionName: string;
}

function formatRelativeTime(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/* ── Inline commit entry with lazy-loaded diff ── */

function CommitEntry({
  commit,
  isExpanded,
  onToggle,
  projectName,
  sessionName,
}: {
  commit: CommitLogEntry;
  isExpanded: boolean;
  onToggle: () => void;
  projectName: string;
  sessionName: string;
}) {
  const diffQuery = useCommitDiffQuery(
    projectName,
    sessionName,
    isExpanded ? commit.fullHash : null,
  );

  return (
    <div className="commit-entry">
      <div
        className={`commit-header${isExpanded ? " expanded" : ""}`}
        onClick={onToggle}
      >
        <span className="commit-hash">{commit.hash}</span>
        <span className="commit-message">{commit.message}</span>
        <span className="commit-meta">
          <span className="commit-files">
            {commit.filesChanged} file
            {commit.filesChanged !== 1 ? "s" : ""}
          </span>
          <span className="commit-date">{formatRelativeTime(commit.date)}</span>
        </span>
      </div>

      {isExpanded && (
        <div className="commit-diff-inline">
          {diffQuery.isPending ? (
            <div className="commit-diff-loading">Loading diff...</div>
          ) : diffQuery.data ? (
            diffQuery.data.files.map((file) => (
              <div key={file.filePath} className="diff-file-section">
                <div className="diff-file-header">
                  <span className="diff-file-name">{file.filePath}</span>
                  <span className="diff-file-stat">
                    <span className="add-count">+{file.additions}</span>{" "}
                    <span className="rm-count">-{file.deletions}</span>
                  </span>
                </div>
                <div className="diff-file-lines">
                  {file.hunks.map((hunk, hunkIdx) => (
                    <div key={hunkIdx}>
                      {hunk.lines.map((line, lineIdx) => (
                        <div key={lineIdx} className={`diff-line ${line.type}`}>
                          {line.content}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))
          ) : (
            <div className="commit-diff-loading">Failed to load diff.</div>
          )}
        </div>
      )}
    </div>
  );
}

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
      <div className="diff-toolbar">
        <div className="diff-toolbar-group">
          <button
            className="diff-nav-btn"
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
            className="diff-nav-btn"
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
        <div className="diff-toolbar-sep" />
        <div className="diff-toolbar-group">
          <button
            className="diff-nav-btn"
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
            >
              <polyline points="9,2 5,7 9,12" />
            </svg>
          </button>
          <span className="diff-toolbar-label">Files</span>
          <button
            className="diff-nav-btn"
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
            >
              <polyline points="5,2 9,7 5,12" />
            </svg>
          </button>
        </div>
        <div className="diff-toolbar-sep" />
        <div className="diff-toolbar-group">
          <button
            className="diff-nav-btn"
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
            >
              <polyline points="9,2 5,7 9,12" />
            </svg>
          </button>
          <span className="diff-toolbar-label">Changes</span>
          <button
            className="diff-nav-btn"
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
            >
              <polyline points="5,2 9,7 5,12" />
            </svg>
          </button>
        </div>
      </div>

      <div className="diff-content" ref={contentRef}>
        {diff.files.length === 0 ? (
          <div className="empty-state" style={{ padding: "var(--space-xl)" }}>
            <div className="empty-state-title">No changes</div>
            <div className="empty-state-desc">
              This session has no uncommitted changes.
            </div>
          </div>
        ) : (
          diff.files.map((file, fileIdx) => {
            const isCollapsed = collapsedFiles.has(fileIdx);
            return (
              <div key={file.filePath} className="diff-file-section">
                <div
                  ref={(el) => {
                    fileHeaderRefs.current[fileIdx] = el;
                  }}
                  className={`diff-file-header${isCollapsed ? " collapsed" : ""}`}
                  onClick={() => toggleFile(fileIdx)}
                >
                  <span className="diff-file-chevron">&#9662;</span>
                  <span className="diff-file-name">{file.filePath}</span>
                  <span className="diff-file-stat">
                    <span className="add-count">+{file.additions}</span>{" "}
                    <span className="rm-count">-{file.deletions}</span>
                  </span>
                </div>
                <div
                  className={`diff-file-lines${isCollapsed ? " collapsed" : ""}`}
                >
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
                                className="diff-line hunk-header"
                              >
                                {line.content}
                              </div>
                            );
                          }
                          return (
                            <div
                              key={lineIdx}
                              className={`diff-line ${line.type}`}
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
          <div className="empty-state">
            <div className="empty-state-title">Loading diff...</div>
          </div>
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
        <div className="session-diff-page stagger-in">
          <div className="sidebar-diff-panel session-diff-fullpage">
            <div className="panel-header">
              <span className="panel-title">Diff vs {targetBranch}</span>
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
              <button
                className="btn btn-sm btn-ghost"
                onClick={handleRefresh}
                disabled={isRefreshing}
                aria-label="Refresh"
                type="button"
                style={{ marginLeft: "auto" }}
              >
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {/* Tab bar */}
            <div className="diff-tab-bar">
              <div className="cc-tabs">
                <button
                  className={`cc-tab${activeTab === "uncommitted" ? " active" : ""}`}
                  onClick={() => setActiveTab("uncommitted")}
                  type="button"
                >
                  Uncommitted
                  {diff.files.length > 0 && (
                    <span className="cc-tab-count">{diff.files.length}</span>
                  )}
                </button>
                <button
                  className={`cc-tab${activeTab === "commits" ? " active" : ""}`}
                  onClick={() => setActiveTab("commits")}
                  type="button"
                >
                  Commits
                  {commits.length > 0 && (
                    <span className="cc-tab-count">{commits.length}</span>
                  )}
                </button>
              </div>
            </div>

            {activeTab === "uncommitted" ? (
              <UncommittedDiff
                diff={diff}
                hotkeysEnabled={activeTab === "uncommitted"}
              />
            ) : (
              <div className="diff-content">
                {commits.length === 0 ? (
                  <div
                    className="empty-state"
                    style={{ padding: "var(--space-xl)" }}
                  >
                    <div className="empty-state-title">No commits</div>
                    <div className="empty-state-desc">
                      Commit changes to see them listed here.
                    </div>
                  </div>
                ) : (
                  <div className="commit-history">
                    {commits.map((commit) => (
                      <CommitEntry
                        key={commit.fullHash}
                        commit={commit}
                        isExpanded={expandedHash === commit.fullHash}
                        onToggle={() =>
                          setExpandedHash((prev) =>
                            prev === commit.fullHash ? null : commit.fullHash,
                          )
                        }
                        projectName={projectName}
                        sessionName={sessionName}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
