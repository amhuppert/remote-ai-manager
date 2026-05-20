"use client";

import dynamic from "next/dynamic";
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

export default function CollabFinalAnswerMessage({
  agent,
  answer,
}: CollabFinalAnswerMessageProps): React.JSX.Element {
  return (
    <article
      className="message assistant collab-final-answer-message"
      data-agent={agent}
      data-kind="final_answer"
      aria-label={`Final answer from ${AGENT_LABEL[agent]}`}
    >
      <header className="collab-final-answer-message-header">
        <span className="collab-final-answer-message-role">
          {AGENT_LABEL[agent]}
        </span>
      </header>

      <div className="message-content collab-final-answer-message-body">
        <MarkdownContent content={answer} />
      </div>
    </article>
  );
}
