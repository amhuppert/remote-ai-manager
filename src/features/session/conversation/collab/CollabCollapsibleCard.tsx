"use client";

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import { cn } from "@/lib/ui/cn";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";

// Agent identity accent: a 3px left border over the card's 1px box.
const agentBorder: Record<CollaborationAgent, string> = {
  claude: "border-l-[3px] border-l-cyan",
  codex: "border-l-[3px] border-l-violet",
};

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
  const [open, setOpen] = useState<boolean>(defaultOpen);
  const orchestration = useContext(CollabCardOrchestrationContext);
  const [prevTick, setPrevTick] = useState<number>(orchestration.tick);
  const bodyId = useId();

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
        agent && agentBorder[agent],
        pulse,
      )}
      data-agent={agent}
      data-kind={kind}
      data-open={open ? "true" : "false"}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-sm border-0 bg-transparent px-md py-sm text-left text-inherit [font:inherit] hover:[background:color-mix(in_srgb,var(--cyan)_4%,transparent)] focus-visible:[outline:2px_solid_var(--cyan)] focus-visible:outline-offset-[-2px] max-768:min-h-[var(--touch-target-min)]"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="inline-flex min-w-0 flex-1 flex-wrap items-center gap-sm">
          {header}
        </span>
        <span
          className="flex-none font-mono text-[0.85rem] text-text-tertiary"
          aria-hidden="true"
        >
          {open ? "▾" : "▸"}
        </span>
      </button>
      <div
        id={bodyId}
        className={cn(
          open ? "flex flex-col" : "hidden",
          "gap-md border-x-0 border-t border-b-0 border-solid border-border-subtle p-md",
        )}
        hidden={!open}
      >
        {children}
      </div>
    </section>
  );
}
