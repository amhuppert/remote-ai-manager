import { CloseIcon, PlusIcon } from "@/components/icons";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationStatus } from "@/lib/conversations/schemas";
import { presentConversationStatus } from "./conversation-status";

export interface ConversationTabItem {
  id: string;
  name: string;
  unread: boolean;
  agent: AgentBackendId;
  /** Turn status — drives the per-tab running/awaiting indicator (Req 12.2). */
  status: ConversationStatus;
}

export interface ConversationTabsProps {
  tabs: ConversationTabItem[];
  activeTabId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewChat: () => void;
}

/**
 * The conversation-pane tab strip: one tab per open project conversation, the
 * active tab marked with a cyan top-edge, a non-active tab with unread activity
 * marked with an amber dot, a per-tab close control, and a `+ New chat`
 * affordance. Presentational — selection/close/new-chat are wired by the page
 * to the view-state store and lifecycle mutations.
 */
export default function ConversationTabs({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onNewChat,
}: ConversationTabsProps): React.JSX.Element {
  return (
    <div className="plc-tabs" role="tablist" aria-label="Conversations">
      {tabs.map((tab) => {
        const active = tab.id === activeTabId;
        const status = presentConversationStatus(tab.status);
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            data-active={active}
            data-agent={tab.agent}
            data-status={tab.status}
            className="plc-tab"
            onClick={() => onSelect(tab.id)}
          >
            {status.dotClass && (
              <span
                className={`status-dot ${status.dotClass}`}
                aria-label={status.label ?? undefined}
              />
            )}
            {!active && tab.unread && (
              <span className="plc-tab-unread" aria-label="Unread activity" />
            )}
            <span className="plc-tab-name">{tab.name}</span>
            <span
              className="plc-tab-close"
              role="button"
              tabIndex={0}
              aria-label={`Close ${tab.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onClose(tab.id);
                }
              }}
            >
              <CloseIcon size={12} />
            </span>
          </button>
        );
      })}
      <button
        type="button"
        className="plc-tab-newchat"
        onClick={onNewChat}
        aria-label="New chat"
      >
        <PlusIcon size={12} />
        New chat
      </button>
    </div>
  );
}
