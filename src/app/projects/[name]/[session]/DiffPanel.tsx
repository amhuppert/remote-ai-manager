"use client";

import { useState, useRef, useCallback } from "react";
import type { SessionDiff } from "@/types";

interface DiffPanelProps {
  diff: SessionDiff;
}

export default function DiffPanel({ diff }: DiffPanelProps): React.JSX.Element {
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

  // Build flat hunk ref index
  let hunkRefIndex = 0;

  return (
    <div className="sidebar-diff-panel">
      <div className="panel-header">
        <span className="panel-title">Diff vs main</span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.68rem",
            color: "var(--text-tertiary)",
          }}
        >
          <span style={{ color: "var(--green)" }}>+{diff.totalAdditions}</span>{" "}
          <span style={{ color: "var(--red)" }}>-{diff.totalDeletions}</span>{" "}
          &middot; {diff.files.length} file{diff.files.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="diff-toolbar">
        <div className="diff-toolbar-group">
          <button
            className="diff-nav-btn"
            onClick={collapseAll}
            title="Collapse all files"
          >
            &#9643;
          </button>
          <button
            className="diff-nav-btn"
            onClick={expandAll}
            title="Expand all files"
          >
            &#9642;
          </button>
        </div>
        <div className="diff-toolbar-sep" />
        <div className="diff-toolbar-group">
          <button className="diff-nav-btn" onClick={() => navigateFile(-1)}>
            &#8249;
          </button>
          <span className="diff-toolbar-label">Files</span>
          <button className="diff-nav-btn" onClick={() => navigateFile(1)}>
            &#8250;
          </button>
        </div>
        <div className="diff-toolbar-sep" />
        <div className="diff-toolbar-group">
          <button className="diff-nav-btn" onClick={() => navigateHunk(-1)}>
            &#8249;
          </button>
          <span className="diff-toolbar-label">Changes</span>
          <button className="diff-nav-btn" onClick={() => navigateHunk(1)}>
            &#8250;
          </button>
        </div>
      </div>

      <div className="diff-content" ref={contentRef}>
        {diff.files.length === 0 ? (
          <div className="empty-state" style={{ padding: "var(--space-xl)" }}>
            <div className="empty-state-title">No changes</div>
            <div className="empty-state-desc">
              This session has no diff vs main yet.
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
    </div>
  );
}
