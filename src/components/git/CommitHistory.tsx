"use client";

import { useState } from "react";
import { cn } from "@/lib/ui/cn";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/Accordion";
import { EmptyStateTitle, EmptyStateDesc } from "@/components/ui/EmptyState";
import type { CommitLogEntry } from "@/lib/git/schemas";
import { useCommitDiffQuery } from "@/lib/git/queries";
import { formatRelativeTime } from "@/lib/shared/format-relative-time";
import {
  DIFF_FILE_SECTION_CLASS,
  DIFF_FILE_HEADER_CLASS,
  DIFF_FILE_NAME_CLASS,
  DIFF_FILE_STAT_CLASS,
  DIFF_LINE_BASE,
  DIFF_LINE_TYPE,
} from "./diff-row-classes";

interface CommitHistoryProps {
  commits: CommitLogEntry[];
  projectName: string;
  sessionName: string;
}

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
      <div className="relative border-x-0 border-t-0 border-b border-solid border-border-subtle before:absolute before:top-0 before:bottom-0 before:left-[18px] before:z-0 before:w-px before:bg-border-default before:content-[''] after:absolute after:top-[50%] after:left-[14px] after:z-[1] after:h-[9px] after:w-[9px] after:-translate-y-1/2 after:rounded-full after:border-2 after:border-solid after:border-border-strong after:bg-bg-surface after:content-[''] after:[transition:all_0.2s_ease] first:before:top-[50%] last:border-b-0 last:before:bottom-[50%] has-[[data-state=open]]:before:top-0 has-[[data-state=open]]:after:top-[20px] has-[[data-state=open]]:after:translate-y-0 has-[[data-state=open]]:after:border-cyan-dim has-[[data-state=open]]:after:bg-cyan-glow has-[[data-state=open]]:after:shadow-[0_0_6px_var(--cyan-glow-strong)] first:has-[[data-state=open]]:before:top-[20px]">
        <AccordionTrigger asChild>
          <button
            type="button"
            // The old clickable `<div>` inherited the page font (15px / 1.5
            // line-height); a bare `<button>` instead picks up the UA default
            // (13.3px / normal, Preflight is off), which shrinks the auto-sized
            // grid rows and shifts the metadata baseline. Pin the div's exact
            // font context to keep row-pitch + text parity.
            className="group/commit-header relative z-[1] grid w-full cursor-pointer grid-cols-[auto_1fr] grid-rows-[auto_auto] items-center gap-x-[8px] gap-y-[2px] border-0 bg-transparent pt-[10px] pr-md pb-[10px] pl-[32px] text-left text-[15px] leading-[1.5] outline-none select-none [transition:background_0.15s_ease] hover:bg-bg-hover focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:[outline-offset:-2px] active:bg-[var(--cc-bg-hover-a80)] data-[state=open]:border-x-0 data-[state=open]:border-t-0 data-[state=open]:border-b data-[state=open]:border-solid data-[state=open]:border-border-subtle data-[state=open]:bg-[var(--cc-cyan-a04)]"
          >
            <span className="col-start-1 row-start-1 w-fit rounded-[3px] border border-solid border-[var(--cc-cyan-a12)] bg-[var(--cc-cyan-a07)] px-[6px] py-[1px] font-mono text-[0.7rem] font-semibold tracking-[0.03em] text-cyan-dim [transition:all_0.2s_ease] group-hover/commit-header:border-[var(--cc-cyan-a25)] group-hover/commit-header:bg-cyan-glow group-hover/commit-header:text-cyan group-data-[state=open]/commit-header:border-cyan-glow-strong group-data-[state=open]/commit-header:bg-cyan-glow group-data-[state=open]/commit-header:text-cyan group-data-[state=open]/commit-header:shadow-[0_0_8px_var(--cc-cyan-a10)]">
              {commit.hash}
            </span>
            <span className="col-start-2 row-start-1 truncate font-body text-[0.78rem] leading-[1.3] font-medium text-text-primary">
              {commit.message}
            </span>
            <span className="[grid-column:1/3] row-start-2 flex items-center gap-sm pt-[1px] font-mono text-[0.7rem] text-text-tertiary">
              <span className="flex items-center gap-[3px] after:ml-[4px] after:opacity-40 after:content-['·']">
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
          <div className="relative ml-[32px] border-y-0 border-r-0 border-l border-solid border-l-border-subtle bg-[var(--cc-bg-void-a30)] font-mono text-[0.75rem] leading-[1.7]">
            {diffQuery.isPending ? (
              <div className="flex items-center gap-sm px-md py-lg font-mono text-[0.72rem] text-text-tertiary before:h-[16px] before:w-[16px] before:animate-[spin_0.7s_linear_infinite] before:rounded-full before:border-2 before:border-solid before:border-border-default before:border-t-cyan-dim before:content-['']">
                Loading diff...
              </div>
            ) : diffQuery.data ? (
              diffQuery.data.files.map((file) => (
                <div key={file.filePath} className={DIFF_FILE_SECTION_CLASS}>
                  <div className={DIFF_FILE_HEADER_CLASS}>
                    <span className={DIFF_FILE_NAME_CLASS}>
                      {file.filePath}
                    </span>
                    <span className={DIFF_FILE_STAT_CLASS}>
                      <span className="text-green">+{file.additions}</span>{" "}
                      <span className="text-red">-{file.deletions}</span>
                    </span>
                  </div>
                  <div className="min-w-fit">
                    {file.hunks.map((hunk, hunkIdx) => (
                      <div key={hunkIdx}>
                        {hunk.lines.map((line, lineIdx) => (
                          <div
                            key={lineIdx}
                            className={cn(
                              DIFF_LINE_BASE,
                              DIFF_LINE_TYPE[line.type],
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
              <div className="flex items-center gap-sm px-md py-lg font-mono text-[0.72rem] text-text-tertiary before:h-[16px] before:w-[16px] before:animate-[spin_0.7s_linear_infinite] before:rounded-full before:border-2 before:border-solid before:border-border-default before:border-t-cyan-dim before:content-['']">
                Failed to load diff.
              </div>
            )}
          </div>
        </AccordionContent>
      </div>
    </AccordionItem>
  );
}

export default function CommitHistory({
  commits,
  projectName,
  sessionName,
}: CommitHistoryProps): React.JSX.Element {
  const [expandedHash, setExpandedHash] = useState<string | null>(null);

  if (commits.length === 0) {
    // The legacy `.empty-state` overrode its `3xl xl` padding to a flat
    // `var(--space-xl)` via inline style, which the EmptyState primitive's baked
    // `px-xl py-3xl` cannot reproduce; the container is inlined with the
    // effective `px-xl py-xl` utilities (mirroring the migrated SessionDiffViewer)
    // while the title/desc use the EmptyState-family primitives.
    return (
      <div className="flex flex-col items-center justify-center px-xl py-xl text-center">
        <EmptyStateTitle>No commits</EmptyStateTitle>
        <EmptyStateDesc>Commit changes to see them listed here.</EmptyStateDesc>
      </div>
    );
  }

  return (
    <Accordion
      type="single"
      collapsible
      value={expandedHash ?? ""}
      onValueChange={(value) => setExpandedHash(value === "" ? null : value)}
      asChild
    >
      <div className="py-sm">
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
  );
}
