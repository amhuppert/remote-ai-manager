"use client";

import type { SessionDiff, CommitLogEntry } from "@/types";
import DiffPanel from "./DiffPanel";
import SpecBrowser from "./SpecBrowser";
import DocsPanel from "./DocsPanel";
import {
  useRightPaneTab,
  useSwitchRightPaneTab,
} from "@/stores/session-detail.store";

interface RightPaneProps {
  diff: SessionDiff;
  commits: CommitLogEntry[];
  projectName: string;
  sessionName: string;
  targetBranch?: string;
}

export default function RightPane({
  diff,
  commits,
  projectName,
  sessionName,
  targetBranch,
}: RightPaneProps): React.JSX.Element {
  const rightPaneTab = useRightPaneTab();
  const switchRightPaneTab = useSwitchRightPaneTab();

  return (
    <div className="right-pane sidebar-diff-panel">
      {/* Tab bar — always visible */}
      <div className="right-pane-tabs">
        <div className="cc-tabs">
          <button
            className={`cc-tab${rightPaneTab === "diff" ? " active" : ""}`}
            onClick={() => switchRightPaneTab("diff")}
            type="button"
          >
            Diff
          </button>
          <button
            className={`cc-tab${rightPaneTab === "docs" ? " active" : ""}`}
            onClick={() => switchRightPaneTab("docs")}
            type="button"
          >
            Docs
          </button>
          <button
            className={`cc-tab${rightPaneTab === "specs" ? " active" : ""}`}
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
            targetBranch={targetBranch}
            hotkeysEnabled={rightPaneTab === "diff"}
          />
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
