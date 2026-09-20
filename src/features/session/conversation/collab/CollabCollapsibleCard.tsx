"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import { cn } from "@/lib/ui/cn";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/Collapsible";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";
import {
  cardRail,
  collabAgentTone,
} from "@/features/session/conversation/collab/card-chrome";

// Navigation pulse: the host (CollabPassage CardHost) carries `group/collab-card`
// and toggles `data-pulse` on jump; the animation rides the card via the group
// variant so no legacy descendant rule survives (conventions §8.2). Only the
// `collab-card-pulse` keyframe stays in conversation.css.
const pulse =
  "group-data-[pulse=true]/collab-card:[animation:collab-card-pulse_1500ms_ease-out] motion-reduce:group-data-[pulse=true]/collab-card:[animation:none] motion-reduce:group-data-[pulse=true]/collab-card:[outline:2px_solid_var(--cyan)] motion-reduce:group-data-[pulse=true]/collab-card:outline-offset-2";

interface CollabCardOrchestrationValue {
  forceState: "open" | "closed" | null;
  tick: number;
}

const CollabCardOrchestrationContext =
  createContext<CollabCardOrchestrationValue>({
    forceState: null,
    tick: 0,
  });

export function CollabCardOrchestrationProvider({
  forceState,
  tick,
  children,
}: {
  forceState: "open" | "closed" | null;
  tick: number;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <CollabCardOrchestrationContext.Provider value={{ forceState, tick }}>
      {children}
    </CollabCardOrchestrationContext.Provider>
  );
}

export interface CollabCollapsibleCardProps {
  agent?: CollaborationAgent;
  kind: string;
  ariaLabel: string;
  defaultOpen?: boolean;
  header: ReactNode;
  children: ReactNode;
}

export default function CollabCollapsibleCard({
  agent,
  kind,
  ariaLabel,
  defaultOpen = false,
  header,
  children,
}: CollabCollapsibleCardProps): React.JSX.Element {
  const orchestration = useContext(CollabCardOrchestrationContext);
  // A card mounted while an orchestration force is already active (e.g. "expand
  // all" was pressed before this card rendered) honours that force; otherwise it
  // falls back to its own defaultOpen. Subsequent forces arrive via tick bumps.
  const [open, setOpen] = useState<boolean>(
    orchestration.forceState !== null
      ? orchestration.forceState === "open"
      : defaultOpen,
  );
  const [prevTick, setPrevTick] = useState<number>(orchestration.tick);

  if (orchestration.tick !== prevTick) {
    setPrevTick(orchestration.tick);
    if (orchestration.forceState !== null) {
      setOpen(orchestration.forceState === "open");
    }
  }

  return (
    <section
      className={cn(
        "flex min-w-0 flex-col overflow-hidden rounded-md border border-solid border-border-subtle bg-bg-raised",
        // Agent identity accent: a 3px left rail over the card's 1px box.
        agent && cardRail,
        pulse,
      )}
      data-agent={agent}
      data-tone={agent && collabAgentTone(agent)}
      data-kind={kind}
      data-open={open ? "true" : "false"}
      aria-label={ariaLabel}
    >
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        layoutClassName="flex min-w-0 flex-col"
      >
        <CollapsibleTrigger hideChevron>
          <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-sm">
            {header}
          </span>
          <span
            className="flex-none font-mono text-[0.85rem] text-text-tertiary"
            aria-hidden="true"
          >
            {open ? "▾" : "▸"}
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-col gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle p-md">
            {children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}
