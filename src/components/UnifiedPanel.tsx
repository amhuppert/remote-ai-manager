"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useActiveConversationsQuery } from "@/lib/queries";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import {
  useUnifiedPanelOpen,
  useCloseUnifiedPanel,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";
import { useActiveWorkflows } from "@/stores/workflow.store";

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

export default function UnifiedPanel(): React.JSX.Element | null {
  const isOpen = useUnifiedPanelOpen();
  const close = useCloseUnifiedPanel();
  const togglePanel = useToggleUnifiedPanel();
  const { data: conversations, isPending } = useActiveConversationsQuery();
  const activeWorkflows = useActiveWorkflows();
  const pathname = usePathname();
  // Extract conversation ID from URL: /projects/<name>/<session>/<conversationId>
  const pathSegments = pathname.split("/");
  const currentConversationId =
    pathSegments.length >= 5 && pathSegments[1] === "projects"
      ? pathSegments[4]
      : null;

  useAppHotkey("toggleActivePanel", togglePanel);

  if (!isOpen) return null;

  return (
    <>
      <div className="unified-panel-backdrop" onClick={close} />
      <aside className="unified-panel">
        <div className="unified-panel-header">
          <span className="unified-panel-title">Active Conversations</span>
          <button
            className="btn-icon-only unified-panel-close"
            onClick={close}
            title="Close panel"
          >
            &#10005;
          </button>
        </div>
        <div className="unified-panel-body">
          {/* Active Workflows */}
          {activeWorkflows.length > 0 && (
            <div className="unified-panel-section">
              <div className="unified-panel-section-title">
                Active Workflows
              </div>
              <ul className="unified-panel-list">
                {activeWorkflows.map((wf) => (
                  <li key={`${wf.projectName}::${wf.sessionName}`}>
                    <Link
                      href={`/projects/${encodeURIComponent(wf.projectName)}/${encodeURIComponent(wf.sessionName)}`}
                      className="unified-panel-item"
                      onClick={close}
                    >
                      <span
                        className={`unified-panel-dot ${wf.status}`}
                        title={wf.status}
                      />
                      <div className="unified-panel-item-body">
                        <div className="unified-panel-item-name">
                          Ralph Loop
                        </div>
                        <div className="unified-panel-item-meta">
                          {wf.projectName} / {wf.sessionName}
                        </div>
                      </div>
                      <div className="unified-panel-item-time">
                        {wf.iterationCount}/{wf.maxIterations}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Active Conversations */}
          {isPending ? (
            <div className="unified-panel-empty">Loading...</div>
          ) : !conversations || conversations.length === 0 ? (
            activeWorkflows.length === 0 && (
              <div className="unified-panel-empty">
                No active conversations.
                <br />
                <span className="unified-panel-empty-hint">
                  New, running, or awaiting conversations will appear here.
                </span>
              </div>
            )
          ) : (
            <ul className="unified-panel-list">
              {conversations.map((convo) => (
                <li key={convo.id}>
                  <Link
                    href={`/projects/${encodeURIComponent(convo.projectName)}/${encodeURIComponent(convo.sessionName)}/${convo.id}`}
                    className={`unified-panel-item${convo.id === currentConversationId ? " active" : ""}`}
                    onClick={close}
                  >
                    <span
                      className={`unified-panel-dot ${convo.status}`}
                      title={convo.status}
                    />
                    <div className="unified-panel-item-body">
                      <div className="unified-panel-item-name">
                        {convo.name ?? "Unnamed conversation"}
                      </div>
                      <div className="unified-panel-item-meta">
                        {convo.projectName} / {convo.sessionName}
                      </div>
                    </div>
                    <div className="unified-panel-item-time">
                      {formatRelativeTime(convo.lastActivityAt)}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}
