"use client";

import type { SessionDiff } from "@/lib/git/schemas";
import { Tabs, Tab } from "@/components/ui/Tabs";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import DiffPanel from "@/features/session/git/DiffPanel";
import SpecBrowser from "@/features/session/conversation/SpecBrowser";
import DocsPanel from "@/features/session/conversation/DocsPanel";
import { useSessionDiffQuery, useCommitsQuery } from "@/lib/git/queries";
import {
  useRightPaneTab,
  useSwitchRightPaneTab,
} from "@/stores/session-detail.store";

const EMPTY_DIFF: SessionDiff = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

interface RightPaneProps {
  projectName: string;
  sessionName: string;
  targetBranch?: string;
}

export default function RightPane({
  projectName,
  sessionName,
  targetBranch,
}: RightPaneProps): React.JSX.Element {
  const rightPaneTab = useRightPaneTab();
  const switchRightPaneTab = useSwitchRightPaneTab();

  // Diff/commits are fetched here (not page-level) so git only runs when the
  // diff tab is the visible right-pane content.
  const diffEnabled = rightPaneTab === "diff";
  const diffQuery = useSessionDiffQuery(projectName, sessionName, {
    enabled: diffEnabled,
  });
  const commitsQuery = useCommitsQuery(projectName, sessionName, {
    enabled: diffEnabled,
  });
  const isLoading = diffQuery.isLoading || commitsQuery.isLoading;
  const diff = diffQuery.data ?? EMPTY_DIFF;
  const commits = commitsQuery.data ?? [];

  return (
    <div className="right-pane sidebar-diff-panel">
      {/* Tab bar — always visible */}
      <div className="shrink-0 rounded-t-lg border border-b-0 border-solid border-border-subtle bg-bg-surface px-md py-sm max-768:hidden">
        <Tabs>
          <Tab
            active={rightPaneTab === "diff"}
            onClick={() => switchRightPaneTab("diff")}
            type="button"
          >
            Diff
          </Tab>
          <Tab
            active={rightPaneTab === "docs"}
            onClick={() => switchRightPaneTab("docs")}
            type="button"
          >
            Docs
          </Tab>
          <Tab
            active={rightPaneTab === "specs"}
            onClick={() => switchRightPaneTab("specs")}
            type="button"
          >
            Specs
          </Tab>
        </Tabs>
      </div>

      {/* Panel body — all panels mounted, inactive hidden via display:none */}
      <div className="right-pane-body flex min-h-0 flex-1 flex-col">
        <div style={{ display: rightPaneTab === "diff" ? "contents" : "none" }}>
          {isLoading ? (
            <div className="sidebar-diff-panel">
              <EmptyState layoutClassName="grow">
                <EmptyStateTitle>Loading diff…</EmptyStateTitle>
              </EmptyState>
            </div>
          ) : (
            <DiffPanel
              diff={diff}
              commits={commits}
              projectName={projectName}
              sessionName={sessionName}
              targetBranch={targetBranch}
              hotkeysEnabled={rightPaneTab === "diff"}
            />
          )}
        </div>
        <div
          style={{
            display: rightPaneTab === "docs" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          <DocsPanel projectName={projectName} sessionName={sessionName} />
        </div>
        <div
          style={{
            display: rightPaneTab === "specs" ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
          }}
        >
          <SpecBrowser projectName={projectName} sessionName={sessionName} />
        </div>
      </div>
    </div>
  );
}
