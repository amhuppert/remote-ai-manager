"use client";

import { cn } from "@/lib/ui/cn";
import { WithTooltip } from "@/components/ui/WithTooltip";
import ConversationSidebar from "@/components/session/sidebar/ConversationSidebar";
import {
  useSidebarCollapsed,
  useToggleSidebar,
} from "@/stores/session-detail.store";

// Main content area with the app-wide conversation/work rail as its first
// column. Hosts that already embed the rail differently (/conversations page
// grid, ProjectCockpit) do not use this component. On mobile the rail's
// drawer stays closed (these pages have no drawer opener); the content column
// takes the full width.
interface WorkRailMainProps {
  /** Both names present → the rail offers "New conversation" in that session. */
  projectName?: string;
  sessionName?: string;
  /**
   * Layout-only classes for the content column. Defaults to the padded
   * scroll column that `.main` provided (`overflow-y-auto p-lg`); full-bleed
   * hosts pass their own overflow/flex classes instead.
   */
  contentClassName?: string;
  children: React.ReactNode;
}

export default function WorkRailMain({
  projectName,
  sessionName,
  contentClassName,
  children,
}: WorkRailMainProps): React.JSX.Element {
  const sidebarCollapsed = useSidebarCollapsed();
  const toggleSidebar = useToggleSidebar();
  const hasSessionContext =
    projectName !== undefined && sessionName !== undefined;

  return (
    <main
      className={cn(
        "grid min-h-0 w-full flex-1 overflow-clip",
        sidebarCollapsed
          ? "grid-cols-[0_minmax(0,1fr)]"
          : "grid-cols-[var(--convo-sidebar-w)_minmax(0,1fr)]",
        "max-768:block",
      )}
    >
      <ConversationSidebar
        projectName={projectName ?? ""}
        sessionName={sessionName ?? ""}
        activeConversationId=""
        showNewConversationButton={hasSessionContext}
      />
      {sidebarCollapsed && (
        <WithTooltip label="Expand sidebar">
          <button
            className="fixed top-1/2 left-0 z-sticky flex h-[48px] w-[20px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-l-none rounded-r-sm border-y border-r border-l-0 border-solid border-border-default bg-bg-raised p-0 text-[0.7rem] text-cyan transition-[color,background-color,border-color,box-shadow] duration-150 ease-[ease] hover:border-cyan-dim hover:bg-bg-elevated hover:text-cyan hover:shadow-[0_0_8px_var(--color-cyan-glow)] max-768:hidden"
            onClick={toggleSidebar}
          >
            {"▶"}
          </button>
        </WithTooltip>
      )}
      <div
        className={cn(
          "min-h-0 min-w-0",
          contentClassName ?? "overflow-x-hidden overflow-y-auto p-lg",
        )}
      >
        {children}
      </div>
    </main>
  );
}
