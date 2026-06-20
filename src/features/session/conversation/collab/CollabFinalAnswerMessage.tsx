"use client";

import dynamic from "next/dynamic";
import { cn } from "@/lib/ui/cn";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";

const MarkdownContent = dynamic(() => import("@/components/MarkdownContent"), {
  ssr: false,
});

export interface CollabFinalAnswerMessageProps {
  agent: CollaborationAgent;
  answer: string;
}

const AGENT_LABEL: Record<CollaborationAgent, string> = {
  claude: "Claude",
  codex: "Codex",
};

// Agent identity accent + role color (legacy `[data-agent=codex]` overrode the
// default cyan).
const borderByAgent: Record<CollaborationAgent, string> = {
  claude: "border-l-cyan",
  codex: "border-l-violet",
};
const roleColorByAgent: Record<CollaborationAgent, string> = {
  claude: "text-cyan",
  codex: "text-violet",
};

export default function CollabFinalAnswerMessage({
  agent,
  answer,
}: CollabFinalAnswerMessageProps): React.JSX.Element {
  return (
    // The component owns `p-md` (its legacy `.collab-final-answer-message`
    // padding). In production (inside `.conversation-virtuoso-item`) the article
    // additionally took a 24px bottom from the shared
    // `.conversation-virtuoso-item .message { padding-bottom }` rule because it
    // carried `.message`. Dropping `.message` (no mixed ownership) is reattached
    // 1:1 with the §8.2 ancestor-context variant so the override still applies
    // in-virtuoso and stays 12px standalone — zero visual change in both. The
    // shared rule itself is untouched (MessageRow owns `.message`).
    // `.message-content` (shared generated-markdown hook) stays on the body.
    <article
      className={cn(
        "relative flex flex-col gap-sm rounded-md border border-l-2 border-solid border-border-subtle bg-bg-surface p-md [.conversation-virtuoso-item_&]:pb-[24px]",
        borderByAgent[agent],
      )}
      data-agent={agent}
      data-kind="final_answer"
      aria-label={`Final answer from ${AGENT_LABEL[agent]}`}
    >
      <header className="flex items-center gap-sm">
        <span
          className={cn(
            "font-mono text-[0.72rem] font-semibold tracking-[0.08em] uppercase",
            roleColorByAgent[agent],
          )}
        >
          {AGENT_LABEL[agent]}
        </span>
      </header>

      <div className="message-content">
        <MarkdownContent content={answer} />
      </div>
    </article>
  );
}
