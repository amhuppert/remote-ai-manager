"use client";

import { useCallback } from "react";

import { extractCopyText } from "@/components/copy-message-text";
import { msgActionBtnClass } from "@/components/CopyMessageButton";
import type { MessageRefMeta } from "@/components/CopyMessageRefButton";
import { WithTooltip } from "@/components/ui/WithTooltip";
import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import type {
  MessageContentBlock,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import {
  ARTIFACT_LIST_STALE_MS,
  useContextArtifacts,
} from "@/lib/context-artifacts/queries";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";

import { useClipLanding } from "./use-clip-landing";

interface ClipMessageButtonProps {
  target: ContextArtifactTarget;
  messageIndex: number;
  role: TranscriptMessage["role"];
  meta: MessageRefMeta;
  /** The message's content blocks — the whole-message clip lands their text. */
  content: MessageContentBlock[];
}

/**
 * The whole-message Clip in the per-message action bar: lands the full message
 * text as a non-code fragment whose provenance is a `<message-ref />` built
 * from exactly the inputs the neighboring Copy-reference action uses —
 * compaction advertisement included. Offered under the same gate, so a row
 * that cannot produce a reference cannot produce a clip either.
 */
export default function ClipMessageButton({
  target,
  messageIndex,
  role,
  meta,
  content,
}: ClipMessageButtonProps): React.JSX.Element {
  const { data: artifacts } = useContextArtifacts(target, {
    staleTime: ARTIFACT_LIST_STALE_MS,
  });
  const { land } = useClipLanding(target.projectName);
  const artifact = artifacts?.find(
    (row) =>
      row.kind === "message_compaction" &&
      row.messageIndex === messageIndex &&
      row.status === "complete",
  );

  const handleClip = useCallback(() => {
    const text = extractCopyText(content);
    // A message with no copyable text (pure tool traffic) has nothing to land.
    if (text.length === 0) return;
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
    void land({ text, isCode: false, provenance: { kind: "ref", xml } });
  }, [content, target, meta, messageIndex, role, artifact, land]);

  return (
    <WithTooltip label="Clip to notepad">
      <button
        type="button"
        className={msgActionBtnClass}
        onClick={handleClip}
        title="Clip message to notepad"
        aria-label="Clip message to notepad"
      >
        <ClipIcon />
      </button>
    </WithTooltip>
  );
}

/** A corner-bracketed plus: content captured into a container. */
function ClipIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M4.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V9.5C1.5 10.0523 1.94772 10.5 2.5 10.5H9.5C10.0523 10.5 10.5 10.0523 10.5 9.5V7.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <path
        d="M8.5 1.5V5.5M6.5 3.5H10.5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
