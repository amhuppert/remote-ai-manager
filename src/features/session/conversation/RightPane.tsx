"use client";

import type { SessionDiff } from "@/lib/git/schemas";
import {
  TabsRoot,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/Tabs";
import { EmptyState, EmptyStateTitle } from "@/components/ui/EmptyState";
import DiffPanel from "@/features/session/git/DiffPanel";
import SpecBrowser from "@/features/session/conversation/SpecBrowser";
import DocsPanel from "@/features/session/conversation/DocsPanel";
import AlignmentPanel from "@/features/session/conversation/AlignmentPanel";
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
  worktreePath: string;
  targetBranch?: string;
}

export default function RightPane({
  projectName,
  sessionName,
  worktreePath,
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
    // `.right-pane`/`.sidebar-diff-panel`/`.right-pane-body` survive as preserved
    // structural hooks (conversation.css / session.css position the DiffPanel +
    // markdown viewer from outside via these descendant selectors), so they stay
    // on plain wrapper divs. TabsRoot nests inside as the APG common ancestor of
    // the tablist + every tabpanel, reproducing the column fill via layoutClassName.
    <div className="right-pane sidebar-diff-panel">
      <TabsRoot
        value={rightPaneTab}
        onValueChange={(v) =>
          switchRightPaneTab(v as Parameters<typeof switchRightPaneTab>[0])
        }
        layoutClassName="flex min-h-0 flex-1 flex-col"
      >
        {/* Tab bar — always visible */}
        <div className="shrink-0 rounded-t-lg border border-b-0 border-solid border-border-subtle bg-bg-surface px-md py-sm max-768:hidden">
          <TabsList>
            <TabsTrigger value="diff">Diff</TabsTrigger>
            <TabsTrigger value="docs">Docs</TabsTrigger>
            <TabsTrigger value="alignment">Alignment</TabsTrigger>
            <TabsTrigger value="specs">Specs</TabsTrigger>
          </TabsList>
        </div>

        {/* Panel body — every tabpanel is force-mounted (forceMount) so its
            internal state survives tab switches; Radix toggles the `hidden`
            attribute on the inactive panels, the active one fills the column. */}
        <div className="right-pane-body flex min-h-0 flex-1 flex-col">
          {/* Diff originally used `display:contents` (boxless, content-sized): its
              `.sidebar-diff-panel` was a non-growing flex child of `.right-pane-body`.
              A transparent `flex flex-col min-h-0` panel (NO `flex-1`) wrapping the
              same `.sidebar-diff-panel` reproduces that geometry — unlike docs/specs,
              which were `flex:1` grow boxes. */}
          <TabsContent
            value="diff"
            forceMount
            layoutClassName="min-h-0 data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
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
          </TabsContent>
          <TabsContent
            value="docs"
            forceMount
            layoutClassName="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            <DocsPanel
              projectName={projectName}
              sessionName={sessionName}
              worktreePath={worktreePath}
            />
          </TabsContent>
          <TabsContent
            value="alignment"
            forceMount
            layoutClassName="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            <AlignmentPanel
              projectName={projectName}
              sessionName={sessionName}
            />
          </TabsContent>
          <TabsContent
            value="specs"
            forceMount
            layoutClassName="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col data-[state=inactive]:hidden"
          >
            <SpecBrowser projectName={projectName} sessionName={sessionName} />
          </TabsContent>
        </div>
      </TabsRoot>
    </div>
  );
}
