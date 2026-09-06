"use client";

import { useId, type ReactNode } from "react";
import { ChevronDownIcon } from "@/components/icons";
import { Badge } from "@/components/ui/Badge";
import { cn } from "@/lib/ui/cn";
import ProjectAvatar from "./ProjectAvatar";
import type { SessionGroup } from "./conversation-session-groups";

interface Props {
  group: SessionGroup;
  onToggle: () => void;
  children: ReactNode;
}

export default function ConversationSessionSection({
  group,
  onToggle,
  children,
}: Props): React.JSX.Element {
  const id = useId();
  const hidden = group.total - group.items.length;
  return (
    <section
      className="mx-sm shrink-0 overflow-hidden rounded-lg border border-solid border-border-strong bg-bg-base shadow-[0_4px_12px_var(--color-bg-void)]"
      data-section-kind="session"
      aria-label={group.label}
    >
      <button
        type="button"
        aria-expanded={group.expanded}
        aria-controls={id}
        onClick={onToggle}
        aria-label={`${group.expanded ? "Collapse" : "Expand"} ${group.sessionLabel ?? "Main"} (${group.projectLabel})`}
        className="group flex w-full cursor-pointer items-center gap-md border-x-0 border-t-0 border-b border-solid border-border-strong bg-bg-raised px-md py-md text-left transition-colors hover:bg-bg-elevated focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px]"
      >
        <ProjectAvatar projectName={group.projectLabel ?? "Project"} />
        <span className="flex min-w-0 flex-1 flex-col gap-xs">
          <span className="truncate font-mono text-[0.65rem] leading-[1.2] font-medium tracking-[0.08em] uppercase text-text-secondary">
            {group.projectLabel}
          </span>
          <span
            className="truncate font-mono text-[0.9rem] leading-[1.4] font-bold text-text-primary"
            title={group.sessionLabel ?? "Main"}
          >
            {group.sessionLabel ?? "Main"}
          </span>
        </span>
        <Badge tier="count">{group.total}</Badge>
        <span
          className={cn(
            "flex shrink-0 items-center text-text-secondary [&>svg]:size-[14px]",
            !group.expanded && "-rotate-90",
          )}
        >
          <ChevronDownIcon />
        </span>
      </button>
      <div id={id} className="m-sm flex flex-col gap-xs">
        {children}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          onClick={onToggle}
          aria-controls={id}
          aria-expanded={false}
          className="flex min-h-[30px] w-full cursor-pointer items-center gap-sm border-x-0 border-t border-b-0 border-solid border-border-default bg-bg-surface px-md py-xs font-mono text-[0.7rem] text-text-secondary hover:bg-bg-raised hover:text-text-primary focus-visible:[outline:2px_solid_var(--color-cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[44px]"
        >
          <span className="text-text-primary">+{hidden} more</span>
          <span className="ml-auto">Expand session</span>
        </button>
      )}
    </section>
  );
}
