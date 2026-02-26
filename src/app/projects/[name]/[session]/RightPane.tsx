"use client";

import type { SessionDiff, CommitLogEntry, SessionCreationMode } from "@/types";
import DiffPanel from "./DiffPanel";
import MarkdownViewer from "@/components/MarkdownViewer";
import ConnectedWorkflowPanel from "./workflow/ConnectedWorkflowPanel";
import { useFocusDocQuery } from "@/lib/queries";
import {
  useRightPaneTab,
  useSwitchRightPaneTab,
} from "@/stores/session-detail.store";

interface RightPaneProps {
  creationMode: SessionCreationMode;
  diff: SessionDiff;
  commits: CommitLogEntry[];
  projectName: string;
  sessionName: string;
  hasWorkflow?: boolean;
}

export default function RightPane({
  creationMode,
  diff,
  commits,
  projectName,
  sessionName,
  hasWorkflow,
}: RightPaneProps): React.JSX.Element {
  const rightPaneTab = useRightPaneTab();
  const switchRightPaneTab = useSwitchRightPaneTab();

  const isFocusMode = creationMode === "focus";
  const showTabs = isFocusMode || hasWorkflow;

  const focusDocQuery = useFocusDocQuery(projectName, sessionName, {
    enabled: isFocusMode,
  });

  // Simple mode: no tabs needed (fast mode, no workflow)
  if (!showTabs) {
    return (
      <DiffPanel
        diff={diff}
        commits={commits}
        projectName={projectName}
        sessionName={sessionName}
      />
    );
  }

  return (
    <div className="right-pane sidebar-diff-panel">
      {/* Tab bar */}
      <div className="right-pane-tabs">
        <div className="filter-pills">
          <button
            className={`filter-pill${rightPaneTab === "diff" ? " active" : ""}`}
            onClick={() => switchRightPaneTab("diff")}
            type="button"
          >
            Diff
          </button>
          {isFocusMode && (
            <button
              className={`filter-pill${rightPaneTab === "focus" ? " active" : ""}`}
              onClick={() => switchRightPaneTab("focus")}
              type="button"
            >
              Focus
            </button>
          )}
          {hasWorkflow && (
            <button
              className={`filter-pill${rightPaneTab === "workflow" ? " active" : ""}`}
              onClick={() => switchRightPaneTab("workflow")}
              type="button"
            >
              Workflow
            </button>
          )}
        </div>
      </div>

      {/* Panel body — all panels mounted, inactive hidden via display:none */}
      <div className="right-pane-body">
        <div style={{ display: rightPaneTab === "diff" ? "contents" : "none" }}>
          <DiffPanel
            diff={diff}
            commits={commits}
            projectName={projectName}
            sessionName={sessionName}
            hotkeysEnabled={rightPaneTab === "diff"}
          />
        </div>
        {isFocusMode && (
          <div
            style={{
              display: rightPaneTab === "focus" ? "flex" : "none",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
            }}
          >
            <MarkdownViewer
              content={focusDocQuery.data ?? null}
              isLoading={focusDocQuery.isPending}
              emptyMessage="Focus document not yet available. It will appear once the agent has analyzed the session objective."
            />
          </div>
        )}
        {hasWorkflow && (
          <div
            style={{
              display: rightPaneTab === "workflow" ? "flex" : "none",
              flexDirection: "column",
              flex: 1,
              minHeight: 0,
              overflow: "auto",
            }}
          >
            <ConnectedWorkflowPanel
              projectName={projectName}
              sessionName={sessionName}
            />
          </div>
        )}
      </div>
    </div>
  );
}
