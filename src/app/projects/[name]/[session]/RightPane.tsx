"use client";

import type { SessionDiff, CommitLogEntry, SessionCreationMode } from "@/types";
import DiffPanel from "./DiffPanel";
import MarkdownViewer from "@/components/MarkdownViewer";
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
}

export default function RightPane({
  creationMode,
  diff,
  commits,
  projectName,
  sessionName,
}: RightPaneProps): React.JSX.Element {
  const rightPaneTab = useRightPaneTab();
  const switchRightPaneTab = useSwitchRightPaneTab();

  const isFocusMode = creationMode === "focus";

  const focusDocQuery = useFocusDocQuery(projectName, sessionName, {
    enabled: isFocusMode,
  });

  // Fast mode or undefined: render DiffPanel directly, no wrapper chrome
  if (!isFocusMode) {
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
          <button
            className={`filter-pill${rightPaneTab === "focus" ? " active" : ""}`}
            onClick={() => switchRightPaneTab("focus")}
            type="button"
          >
            Focus
          </button>
        </div>
      </div>

      {/* Panel body — both panels mounted, inactive hidden via display:none */}
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
      </div>
    </div>
  );
}
