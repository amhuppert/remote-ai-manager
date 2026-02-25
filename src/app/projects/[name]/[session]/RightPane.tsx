"use client";

import type { SessionDiff, CommitLogEntry, SessionCreationMode } from "@/types";
import DiffPanel from "./DiffPanel";
import SpecBrowser from "./SpecBrowser";
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

  return (
    <div className="right-pane sidebar-diff-panel">
      {/* Tab bar — always visible */}
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
          <button
            className={`filter-pill${rightPaneTab === "specs" ? " active" : ""}`}
            onClick={() => switchRightPaneTab("specs")}
            type="button"
          >
            Specs
          </button>
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
