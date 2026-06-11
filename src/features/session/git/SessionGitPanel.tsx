"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";

type GitTab = "changes" | "commits";

interface SessionGitPanelProps {
  diff: SessionDiff;
  commits: CommitLogEntry[];
  projectName: string;
  sessionName: string;
  isRefreshing?: boolean;
  onRefresh?: () => void;
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

function FileIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      className="git-panel-file-icon"
    >
      <path
        d="M4 1.5h5.586a1 1 0 0 1 .707.293l2.414 2.414a1 1 0 0 1 .293.707V13.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <path
        d="M9.5 1.5V4.5a1 1 0 0 0 1 1H13"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="3" stroke="currentColor" strokeWidth="1.2" />
      <path d="M8 1v4M8 11v4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

export default function SessionGitPanel({
  diff,
  commits,
  projectName,
  sessionName,
  isRefreshing = false,
  onRefresh,
}: SessionGitPanelProps): React.JSX.Element {
  const diffHref = `/projects/${encodeURIComponent(projectName)}/${encodeURIComponent(sessionName)}/diff`;
  const hasChanges = diff.files.length > 0;
  const hasCommits = commits.length > 0;
  const defaultTab: GitTab = hasChanges ? "changes" : "commits";
  const [activeTab, setActiveTab] = useState<GitTab>(defaultTab);
  const [collapsed, setCollapsed] = useState(false);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const noActivity = !hasChanges && !hasCommits;

  return (
    <div className={`git-panel${collapsed ? " collapsed" : ""}`}>
      {/* Header */}
      <div
        className="cc-section-header git-panel-header"
        onClick={toggleCollapsed}
      >
        <div className="git-panel-header-left">
          <span
            className={`cc-section-chevron${collapsed ? " collapsed" : ""}`}
          >
            &#9662;
          </span>
          <span className="cc-section-label">Git</span>
          {hasChanges && (
            <span className="git-panel-summary">
              <span className="cc-section-count">
                {diff.files.length} file{diff.files.length !== 1 ? "s" : ""}{" "}
                changed
              </span>
              <span className="git-panel-stat-add">+{diff.totalAdditions}</span>
              <span className="git-panel-stat-rm">
                &minus;{diff.totalDeletions}
              </span>
            </span>
          )}
          {!hasChanges && hasCommits && (
            <span className="git-panel-summary">
              <span className="cc-section-count">
                {commits.length} commit{commits.length !== 1 ? "s" : ""}
              </span>
            </span>
          )}
        </div>
        <div
          className="cc-section-actions git-panel-header-actions"
          onClick={(e) => e.stopPropagation()}
        >
          {onRefresh && (
            <button
              className="btn btn-sm btn-ghost"
              onClick={onRefresh}
              disabled={isRefreshing}
              data-tooltip="Refresh git status"
              aria-label="Refresh"
              type="button"
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </button>
          )}
          {(hasChanges || hasCommits) && (
            <Link href={diffHref} className="btn btn-sm btn-ghost">
              View Diff
            </Link>
          )}
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="git-panel-body">
          {/* Tab bar */}
          {(hasChanges || hasCommits) && (
            <div className="cc-tabs">
              <button
                className={`cc-tab${activeTab === "changes" ? " active" : ""}`}
                onClick={() => setActiveTab("changes")}
              >
                Changes
                {hasChanges && (
                  <span className="cc-tab-count">{diff.files.length}</span>
                )}
              </button>
              <button
                className={`cc-tab${activeTab === "commits" ? " active" : ""}`}
                onClick={() => setActiveTab("commits")}
              >
                Commits
                {hasCommits && (
                  <span className="cc-tab-count">{commits.length}</span>
                )}
              </button>
            </div>
          )}

          {/* Empty state when nothing at all */}
          {noActivity ? (
            <div className="git-panel-empty">
              No changes or commits in this session
            </div>
          ) : (
            <>
              {/* Changes list */}
              {activeTab === "changes" && (
                <div className="git-panel-content">
                  {hasChanges ? (
                    <div className="git-panel-file-list">
                      {diff.files.map((file) => (
                        <div key={file.filePath} className="git-panel-file-row">
                          <FileIcon />
                          <span className="git-panel-file-path">
                            {file.filePath}
                          </span>
                          <span className="git-panel-file-stat">
                            <span className="git-panel-stat-add">
                              +{file.additions}
                            </span>
                            <span className="git-panel-stat-rm">
                              &minus;{file.deletions}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="git-panel-empty">
                      No uncommitted changes
                    </div>
                  )}
                </div>
              )}

              {/* Commits list */}
              {activeTab === "commits" && (
                <div className="git-panel-content">
                  {hasCommits ? (
                    <div className="git-panel-commit-list">
                      {commits.map((commit) => (
                        <div key={commit.hash} className="git-panel-commit-row">
                          <CommitIcon />
                          <span className="git-panel-commit-hash">
                            {commit.hash}
                          </span>
                          <span className="git-panel-commit-msg">
                            {commit.message}
                          </span>
                          <span className="git-panel-commit-meta">
                            {commit.filesChanged}f
                          </span>
                          <span className="git-panel-commit-meta">
                            {formatRelativeTime(commit.date)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="git-panel-empty">No commits yet</div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
