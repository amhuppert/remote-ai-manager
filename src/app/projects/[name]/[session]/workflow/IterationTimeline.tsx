"use client";

import { useState } from "react";
import type { IterationMeta } from "./types";

interface IterationTimelineProps {
  iterations: IterationMeta[];
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function getDotVariant(
  iteration: IterationMeta,
): "error" | "timeout" | "no-progress" | "" {
  if (iteration.status === "error") return "error";
  if (iteration.status === "timeout") return "timeout";
  if (iteration.progressClassification === "no_progress") return "no-progress";
  return "";
}

export default function IterationTimeline({
  iterations,
}: IterationTimelineProps) {
  const [expandedIteration, setExpandedIteration] = useState<number | null>(
    null,
  );

  if (iterations.length === 0) return null;

  const sorted = [...iterations].reverse();

  function toggleExpand(iterationNumber: number) {
    setExpandedIteration((prev) =>
      prev === iterationNumber ? null : iterationNumber,
    );
  }

  return (
    <div className="wf-section">
      <span className="wf-section-label">Iteration History</span>
      <div className="iteration-timeline">
        {sorted.map((iter) => {
          const variant = getDotVariant(iter);
          const isExpanded = expandedIteration === iter.iterationNumber;
          return (
            <div
              key={iter.iterationNumber}
              className={`iteration-card${variant ? ` ${variant}` : ""}${isExpanded ? " expanded" : ""}`}
            >
              <div className="iteration-card-dot" />
              <div className="iteration-card-content">
                <div className="iteration-card-header">
                  <span className="iteration-card-number">
                    #{iter.iterationNumber}
                  </span>
                  <span className="iteration-card-duration">
                    {formatDuration(iter.durationMs)}
                  </span>
                  <span className="iteration-card-cost">
                    {formatCost(iter.costUsd)}
                  </span>
                  <button
                    className="iteration-card-expand"
                    onClick={() => toggleExpand(iter.iterationNumber)}
                    aria-expanded={isExpanded}
                    aria-label={
                      isExpanded ? "Collapse details" : "Expand details"
                    }
                  >
                    {isExpanded ? "\u25BC" : "\u25B6"}
                  </button>
                </div>
                <div className="iteration-card-metrics">
                  <span className="iteration-card-files">
                    {iter.gitMetrics.filesChanged} files
                    {iter.gitMetrics.linesAdded > 0 && (
                      <span className="added">
                        {" "}
                        +{iter.gitMetrics.linesAdded}
                      </span>
                    )}
                    {iter.gitMetrics.linesRemoved > 0 && (
                      <span className="removed">
                        {" "}
                        -{iter.gitMetrics.linesRemoved}
                      </span>
                    )}
                  </span>
                  {iter.statusReport && (
                    <span
                      className={`work-type-badge ${iter.statusReport.work_type}`}
                    >
                      {iter.statusReport.work_type}
                    </span>
                  )}
                  {iter.statusReport && (
                    <span
                      className={`iteration-card-exit-signal ${String(iter.statusReport.exit_signal)}`}
                    >
                      exit:{" "}
                      {iter.statusReport.exit_signal ? "\u2713" : "\u2014"}
                    </span>
                  )}
                  {iter.status === "error" && (
                    <span className="iteration-card-error-badge">error</span>
                  )}
                  {iter.status === "timeout" && (
                    <span className="iteration-card-timeout-badge">
                      timeout
                    </span>
                  )}
                </div>
                {iter.statusReport?.work_summary && (
                  <div className="iteration-card-summary">
                    {iter.statusReport.work_summary}
                  </div>
                )}

                {/* Expanded detail panel */}
                {isExpanded && (
                  <div className="iteration-card-detail">
                    {/* Diff summary */}
                    {iter.gitMetrics.changedFiles.length > 0 ? (
                      <>
                        <div className="iteration-diff-summary">
                          {iter.gitMetrics.filesChanged} files{" "}
                          <span className="added">
                            +{iter.gitMetrics.linesAdded}
                          </span>{" "}
                          <span className="removed">
                            -{iter.gitMetrics.linesRemoved}
                          </span>
                        </div>
                        <div className="iteration-diff-files">
                          {iter.gitMetrics.changedFiles.map((file) => (
                            <div key={file} className="iteration-diff-file">
                              {file}
                            </div>
                          ))}
                        </div>
                      </>
                    ) : (
                      <div className="iteration-diff-empty">
                        No file changes in this iteration
                      </div>
                    )}

                    {/* Transcript link */}
                    <div className="iteration-transcript-link">
                      View transcript ({iter.turns} turns)
                    </div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
