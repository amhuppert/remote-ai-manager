"use client";

import {
  createContext,
  useContext,
  useId,
  useState,
  type ReactNode,
} from "react";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";

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
      className="collab-artifact-card"
      data-agent={agent}
      data-kind={kind}
      data-open={open ? "true" : "false"}
      aria-label={ariaLabel}
    >
      <button
        type="button"
        className="collab-artifact-card-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="collab-artifact-card-header">{header}</span>
        <span className="collab-artifact-card-chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
      </button>
      <div id={bodyId} className="collab-artifact-card-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}
