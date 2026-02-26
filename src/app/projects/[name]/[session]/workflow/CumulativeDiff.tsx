"use client";

import { useState, useMemo } from "react";
import type { IterationMeta } from "./types";

interface CumulativeDiffProps {
  iterations: IterationMeta[];
}

export default function CumulativeDiff({ iterations }: CumulativeDiffProps) {
  const [expanded, setExpanded] = useState(false);

  const stats = useMemo(() => {
    let totalAdded = 0;
    let totalRemoved = 0;
    const fileSet = new Set<string>();

    for (const iter of iterations) {
      totalAdded += iter.gitMetrics.linesAdded;
      totalRemoved += iter.gitMetrics.linesRemoved;
      for (const file of iter.gitMetrics.changedFiles) {
        fileSet.add(file);
      }
    }

    return {
      totalAdded,
      totalRemoved,
      uniqueFiles: [...fileSet].sort(),
    };
  }, [iterations]);

  if (iterations.length === 0) return null;

  return (
    <div className="cumulative-diff">
      <button
        className="cumulative-diff-toggle"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
      >
        <span className={`cumulative-diff-arrow${expanded ? " expanded" : ""}`}>
          {"\u25B8"}
        </span>
        Code Changes
      </button>
      <div className="cumulative-diff-summary">
        {stats.uniqueFiles.length} files{" "}
        <span className="added">+{stats.totalAdded}</span>{" "}
        <span className="removed">-{stats.totalRemoved}</span>
      </div>
      {expanded && (
        <div className="cumulative-diff-files">
          {stats.uniqueFiles.map((file) => (
            <div key={file} className="cumulative-diff-file">
              {file}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
