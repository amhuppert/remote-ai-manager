"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useActiveConversationsQuery } from "@/lib/queries";
import { useAppHotkey } from "@/hooks/useAppHotkey";
import { CloseIcon } from "@/components/icons";
import {
  useUnifiedPanelOpen,
  useCloseUnifiedPanel,
  useToggleUnifiedPanel,
} from "@/stores/unified-panel.store";

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
  const { data: activeData, isPending } = useActiveConversationsQuery();
  const conversations = activeData?.conversations;
  const graphWorkflowExecutions = activeData?.graphWorkflowExecutions;
  const activeCollaborationExecutions =
    activeData?.activeCollaborationExecutions;
  const pathname = usePathname();
  // Extract conversation ID from URL: /projects/<name>/<session>/<conversationId>
  const pathSegments = pathname.split("/");
  const currentConversationId =
    pathSegments.length >= 5 && pathSegments[1] === "projects"
      ? pathSegments[4]
      : null;

  useAppHotkey("toggleActivePanel", togglePanel);

  if (!isOpen) return null;

  const hasGraphWorkflows =
    graphWorkflowExecutions && graphWorkflowExecutions.length > 0;
  const hasCollaborations =
    activeCollaborationExecutions && activeCollaborationExecutions.length > 0;
  const hasConversations = conversations && conversations.length > 0;
  const hasAnyContent =
    hasGraphWorkflows || hasCollaborations || hasConversations;

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
            aria-label="Close panel"
          >
            <CloseIcon />
          </button>
        </div>
        <div className="unified-panel-body">
          {/* Active Graph Workflow Executions */}
          {hasGraphWorkflows && (
            <div className="unified-panel-section">
              <div className="unified-panel-section-title">Graph Workflows</div>
              <ul className="unified-panel-list">
                {graphWorkflowExecutions.map((gw) => (
                  <li key={gw.executionId}>
                    <Link
                      href={`/projects/${encodeURIComponent(gw.projectName)}/${encodeURIComponent(gw.sessionName)}/workflow`}
                      className="unified-panel-item"
                      onClick={close}
                    >
                      <span
                        className={`unified-panel-dot ${gw.status}`}
                        title={gw.status}
                      />
                      <div className="unified-panel-item-body">
                        <div className="unified-panel-item-name">
                          {gw.activeContextTitles.length > 0
                            ? gw.activeContextTitles.join(" + ")
                            : "Graph Workflow"}
                        </div>
                        <div className="unified-panel-item-meta">
                          {gw.projectName} / {gw.sessionName}
                        </div>
                      </div>
                      <div className="unified-panel-item-time">
                        {gw.completedContexts}/{gw.totalContexts}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {hasCollaborations && (
            <div className="unified-panel-section">
              <div className="unified-panel-section-title">Collaborations</div>
              <ul className="unified-panel-list">
                {activeCollaborationExecutions.map((collab) => {
                  const href = collab.conversationId
                    ? `/projects/${encodeURIComponent(collab.projectName)}/${encodeURIComponent(collab.sessionName)}/${collab.conversationId}`
                    : `/projects/${encodeURIComponent(collab.projectName)}/${encodeURIComponent(collab.sessionName)}`;
                  return (
                    <li key={collab.workflowId}>
                      <Link
                        href={href}
                        className="unified-panel-item"
                        onClick={close}
                      >
                        <span
                          className={`unified-panel-dot ${collab.status}`}
                          title={collab.status}
                        />
                        <div className="unified-panel-item-body">
                          <div className="unified-panel-item-name">
                            Collaboration ({collab.status})
                          </div>
                          <div className="unified-panel-item-meta">
                            {collab.projectName} / {collab.sessionName}
                          </div>
                        </div>
                        <div className="unified-panel-item-time">
                          {formatRelativeTime(collab.updatedAt)}
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Active Conversations */}
          {isPending ? (
            <div className="unified-panel-empty">Loading...</div>
          ) : !hasAnyContent ? (
            <div className="unified-panel-empty">
              No active conversations.
              <br />
              <span className="unified-panel-empty-hint">
                New, running, or awaiting conversations will appear here.
              </span>
            </div>
          ) : hasConversations ? (
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
          ) : null}
        </div>
      </aside>
    </>
  );
}
