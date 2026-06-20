"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import type { SessionDiff, CommitLogEntry } from "@/lib/git/schemas";
import { Button } from "@/components/ui/Button";
import {
  SectionChevron,
  SectionLabel,
  SectionCount,
  SectionActions,
} from "@/components/ui/SectionHeader";
import { Tabs, Tab, TabCount } from "@/components/ui/Tabs";

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
      className="shrink-0 text-text-tertiary"
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
    <div className="overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-surface">
      {/* Header. Clickable collapse bar: the `.cc-section-header` recipe (flex /
          items-center / gap-sm / min-h-28 / mb-header-content) is inlined as
          utilities rather than wrapped in <SectionHeader> because this container
          also carries padding / cursor / hover-bg / transition / select-none /
          justify-between — none of which are layout-allowed in the primitive's
          `layoutClassName` (eslint no-appearance-in-layout-classname). This
          mirrors the clickable-header idiom in InspectorConfigBlock. The legacy
          `gap-md` utility was dead (the unlayered recipe's `gap:var(--space-sm)`
          beat the layered utility), so the byte-identical gap is `gap-sm`. The
          leaf chevron/label/count/actions use the SectionHeader-family primitives. */}
      <div
        className="mb-header-content flex min-h-[28px] cursor-pointer items-center justify-between gap-sm px-md py-sm transition-colors duration-150 select-none hover:bg-bg-hover"
        onClick={toggleCollapsed}
      >
        <div className="flex min-w-0 items-center gap-sm">
          <SectionChevron collapsed={collapsed}>&#9662;</SectionChevron>
          <SectionLabel>Git</SectionLabel>
          {hasChanges && (
            <span className="flex items-center gap-xs font-mono text-[0.72rem] text-text-tertiary">
              <SectionCount>
                {diff.files.length} file{diff.files.length !== 1 ? "s" : ""}{" "}
                changed
              </SectionCount>
              <span className="font-mono text-[0.72rem] text-green">
                +{diff.totalAdditions}
              </span>
              <span className="font-mono text-[0.72rem] text-red">
                &minus;{diff.totalDeletions}
              </span>
            </span>
          )}
          {!hasChanges && hasCommits && (
            <span className="flex items-center gap-xs font-mono text-[0.72rem] text-text-tertiary">
              <SectionCount>
                {commits.length} commit{commits.length !== 1 ? "s" : ""}
              </SectionCount>
            </span>
          )}
        </div>
        <SectionActions
          layoutClassName="shrink-0"
          onClick={(e) => e.stopPropagation()}
        >
          {onRefresh && (
            <Button
              variant="ghost"
              size="sm"
              touch
              onClick={onRefresh}
              disabled={isRefreshing}
              data-tooltip="Refresh git status"
              aria-label="Refresh"
              type="button"
            >
              {isRefreshing ? "Refreshing..." : "Refresh"}
            </Button>
          )}
          {/* ESCAPE HATCH: View Diff is a Next <Link> (real <a> navigation +
              modifier-click). <Button> renders <button> only, and a polymorphic
              Button is a non-goal ("do NOT build new primitives"), so swapping
              would change the element type and break navigation. Retained on the
              `.btn btn-sm btn-ghost` leaf classes (byte-identical to the adjacent
              ghost-sm <Button>); the `.btn*` recipes survive integration anyway
              (many other consumers). Remediation: polymorphic Button / Link slot. */}
          {(hasChanges || hasCommits) && (
            <Link href={diffHref} className="btn btn-sm btn-ghost">
              View Diff
            </Link>
          )}
        </SectionActions>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="border-x-0 border-t border-b-0 border-solid border-border-subtle">
          {/* Tab bar */}
          {(hasChanges || hasCommits) && (
            <Tabs>
              <Tab
                active={activeTab === "changes"}
                onClick={() => setActiveTab("changes")}
              >
                Changes
                {hasChanges && (
                  <TabCount active={activeTab === "changes"}>
                    {diff.files.length}
                  </TabCount>
                )}
              </Tab>
              <Tab
                active={activeTab === "commits"}
                onClick={() => setActiveTab("commits")}
              >
                Commits
                {hasCommits && (
                  <TabCount active={activeTab === "commits"}>
                    {commits.length}
                  </TabCount>
                )}
              </Tab>
            </Tabs>
          )}

          {/* Empty state when nothing at all */}
          {noActivity ? (
            <div className="px-md py-lg text-center font-mono text-[0.72rem] text-text-tertiary">
              No changes or commits in this session
            </div>
          ) : (
            <>
              {/* Changes list */}
              {activeTab === "changes" && (
                <div className="max-h-[320px] overflow-y-auto">
                  {hasChanges ? (
                    <div className="flex flex-col">
                      {diff.files.map((file) => (
                        <div
                          key={file.filePath}
                          className="flex items-center gap-sm px-md py-[6px] font-mono text-[0.72rem] transition-[background] duration-100 ease-[ease] hover:bg-bg-hover"
                        >
                          <FileIcon />
                          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text-secondary">
                            {file.filePath}
                          </span>
                          <span className="flex shrink-0 gap-xs text-[0.7rem]">
                            <span className="font-mono text-[0.72rem] text-green">
                              +{file.additions}
                            </span>
                            <span className="font-mono text-[0.72rem] text-red">
                              &minus;{file.deletions}
                            </span>
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-md py-lg text-center font-mono text-[0.72rem] text-text-tertiary">
                      No uncommitted changes
                    </div>
                  )}
                </div>
              )}

              {/* Commits list */}
              {activeTab === "commits" && (
                <div className="max-h-[320px] overflow-y-auto">
                  {hasCommits ? (
                    <div className="flex flex-col">
                      {commits.map((commit) => (
                        <div
                          key={commit.hash}
                          className="flex items-center gap-sm px-md py-[6px] font-mono text-[0.72rem] transition-[background] duration-100 ease-[ease] hover:bg-bg-hover [&_svg]:shrink-0 [&_svg]:text-cyan-dim"
                        >
                          <CommitIcon />
                          <span className="shrink-0 text-[0.7rem] text-cyan-dim">
                            {commit.hash}
                          </span>
                          <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-text-secondary">
                            {commit.message}
                          </span>
                          <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
                            {commit.filesChanged}f
                          </span>
                          <span className="shrink-0 text-[0.7rem] whitespace-nowrap text-text-tertiary">
                            {formatRelativeTime(commit.date)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-md py-lg text-center font-mono text-[0.72rem] text-text-tertiary">
                      No commits yet
                    </div>
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
