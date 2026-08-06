import { CloseIcon, PlusIcon } from "@/components/icons";
import NewConversationProfileButton from "@/components/agent-profiles/NewConversationProfileButton";
import { Spinner } from "@/components/ui/Spinner";
import { StatusDot } from "@/components/ui/StatusDot";
import type { AgentProfileRef } from "@/lib/agent-profiles/schemas";
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
  /** Omitting the profile creates under the Standard Agent default (R7). */
  onNewChat: (profile?: AgentProfileRef) => void;
  projectName: string;
  /** True while the create-conversation mutation is pending — the `+ New chat`
   * affordance disables and shows in-progress state. */
  creating?: boolean;
}

const TAB_STRIP_CLASS =
  "flex items-stretch gap-2xs p-2xs border-x-0 border-t-0 border-b border-solid border-border-dim overflow-x-auto shrink-0";

// Active beats hover (legacy source order). Gated on mutually-exclusive
// data-active values so the result is independent of utility emission order. The
// cyan top-edge is the active ::before bar.
const TAB_CLASS =
  "relative inline-flex items-center gap-xs px-sm py-xs rounded-sm border-0 bg-transparent " +
  "font-mono text-[0.74rem] font-medium text-text-secondary cursor-pointer whitespace-nowrap " +
  "transition-[background,color] duration-150 ease-[ease] " +
  "data-[active=false]:hover:bg-bg-hover data-[active=false]:hover:text-text-primary " +
  "data-[active=true]:bg-bg-raised data-[active=true]:text-text-primary " +
  "data-[active=true]:before:content-[''] data-[active=true]:before:absolute data-[active=true]:before:inset-x-0 " +
  "data-[active=true]:before:top-0 data-[active=true]:before:h-[2px] data-[active=true]:before:bg-cyan data-[active=true]:before:rounded-t-sm";

const TAB_CLOSE_CLASS =
  "inline-flex items-center justify-center size-[16px] border-0 bg-transparent text-text-tertiary " +
  "cursor-pointer rounded-sm hover:bg-bg-elevated hover:text-text-primary";

const TAB_NEWCHAT_CLASS =
  "inline-flex items-center gap-2xs px-sm py-xs rounded-sm border border-dashed border-border-subtle " +
  "bg-transparent text-text-secondary font-mono text-[0.74rem] cursor-pointer " +
  "transition-[background,color,border-color] duration-150 ease-[ease] " +
  "hover:bg-bg-hover hover:text-text-primary hover:border-border-default " +
  "disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent " +
  "disabled:hover:text-text-secondary disabled:hover:border-border-subtle";

/**
 * The conversation-pane tab strip: one tab per open project conversation, the
 * active tab marked with a cyan top-edge, a non-active tab with unread activity
 * marked with an amber dot, a per-tab close control, and a `+ New chat`
 * affordance. Selection/close/new-chat are wired by the page to the view-state
 * store and lifecycle mutations.
 *
 * The `+ New chat` control stays a single click under the Standard Agent
 * default; its profile companion is what makes the identity selection visible
 * on this creation path (R7.1), and it reads the library itself because the
 * affordance it belongs to lives here.
 */
export default function ConversationTabs({
  tabs,
  activeTabId,
  projectName,
  onSelect,
  onClose,
  onNewChat,
  creating = false,
}: ConversationTabsProps): React.JSX.Element {
  return (
    <div className={TAB_STRIP_CLASS} role="tablist" aria-label="Conversations">
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
            className={TAB_CLASS}
            onClick={() => onSelect(tab.id)}
          >
            {status.dotClass && (
              <StatusDot
                tone={status.dotClass}
                aria-label={status.label ?? undefined}
              />
            )}
            {!active && tab.unread && (
              <span
                className="size-[6px] shrink-0 rounded-full bg-amber"
                aria-label="Unread activity"
              />
            )}
            <span className="max-w-[14ch] overflow-hidden text-ellipsis">
              {tab.name}
            </span>
            <span
              className={TAB_CLOSE_CLASS}
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
        className={TAB_NEWCHAT_CLASS}
        onClick={() => onNewChat()}
        disabled={creating}
        aria-busy={creating || undefined}
        aria-label="New chat"
      >
        {creating ? (
          <Spinner size="sm" tone="inherit" />
        ) : (
          <PlusIcon size={12} />
        )}
        {creating ? "Creating…" : "New chat"}
      </button>
      <NewConversationProfileButton
        projectName={projectName}
        pending={creating === true}
        onCreate={onNewChat}
      />
    </div>
  );
}
