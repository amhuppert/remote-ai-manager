"use client";

import { useState } from "react";
import type { CommitLogEntry } from "@/types";
import { useCommitDiffQuery } from "@/lib/queries";

interface CommitHistoryProps {
  commits: CommitLogEntry[];
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
          <span className="commit-date">
            {formatRelativeTime(commit.date)}
          </span>
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
                        <div
                          key={lineIdx}
                          className={`diff-line ${line.type}`}
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
            <div className="commit-diff-loading">Failed to load diff.</div>
          )}
        </div>
      )}
    </div>
  );
}

export default function CommitHistory({
  commits,
  projectName,
  sessionName,
}: CommitHistoryProps): React.JSX.Element {
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  if (commits.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "var(--space-xl)" }}>
        <div className="empty-state-title">No commits</div>
        <div className="empty-state-desc">
          Commit changes to see them listed here.
        </div>
      </div>
    );
  }

  return (
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
  );
}
