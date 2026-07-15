"use client";

import { useState, useCallback } from "react";
import { cn } from "@/lib/ui/cn";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
import {
  ARTIFACT_LIST_STALE_MS,
  useContextArtifacts,
} from "@/lib/context-artifacts/queries";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";
import { msgActionBtnClass } from "./CopyMessageButton";

/**
 * Per-message metadata the reference carries beyond the conversation identity
 * already present in the `ContextArtifactTarget`.
 */
export interface MessageRefMeta {
  conversationName: string | null;
  timestamp: string | null;
  model: string | null;
}

interface CopyMessageRefButtonProps {
  target: ContextArtifactTarget;
  messageIndex: number;
  role: TranscriptMessage["role"];
  meta: MessageRefMeta;
}

/**
 * Copies a `<message-ref ... />` XML tag for this message to the clipboard —
 * a reference an agent can resolve via the embedded cctl commands, and which
 * the prompt editor swaps for a mention chip on paste.
 */
export default function CopyMessageRefButton({
  target,
  messageIndex,
  role,
  meta,
}: CopyMessageRefButtonProps) {
  const [copied, setCopied] = useState(false);
  const { data: artifacts } = useContextArtifacts(target, {
    staleTime: ARTIFACT_LIST_STALE_MS,
  });
  const artifact = artifacts?.find(
    (row) =>
      row.kind === "message_compaction" &&
      row.messageIndex === messageIndex &&
      row.status === "complete",
  );

  const handleCopy = useCallback(() => {
    const xml = buildMessageRefXml({
      projectName: target.projectName,
      sessionName: target.scope === "session" ? target.sessionName : null,
      conversationId: target.conversationId,
      conversationName: meta.conversationName,
      messageIndex,
      role,
      timestamp: meta.timestamp,
      model: meta.model,
      compaction: artifact
        ? { artifactId: artifact.id, createdAt: artifact.createdAt }
        : null,
    });
    void navigator.clipboard.writeText(xml).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [target, messageIndex, role, meta, artifact]);

  return (
    <WithTooltip label={copied ? "Copied ✓" : "Copy reference"}>
      <button
        type="button"
        className={cn(msgActionBtnClass, "data-[copied=true]:text-green")}
        data-copied={copied}
        onClick={handleCopy}
        title="Copy message reference"
        aria-label="Copy message reference"
      >
        {copied ? (
          <svg
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M1.5 5.5L4 8L8.5 2"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <span
            aria-hidden="true"
            className="font-mono text-[13px] leading-none font-semibold"
          >
            #
          </span>
        )}
      </button>
    </WithTooltip>
  );
}
