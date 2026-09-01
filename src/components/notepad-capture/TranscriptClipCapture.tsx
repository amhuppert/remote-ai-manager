"use client";

import { useCallback } from "react";

import { buildMessageRefXml } from "@/lib/conversations/message-ref";
import {
  ARTIFACT_LIST_STALE_MS,
  useContextArtifacts,
} from "@/lib/context-artifacts/queries";
import type { ContextArtifactTarget } from "@/lib/context-artifacts/query-keys";

import { TranscriptClipAffordance } from "./TranscriptClipAffordance";
import type { TranscriptClipDraft } from "./use-transcript-clip-selection";
import { useClipLanding } from "./use-clip-landing";

export interface TranscriptClipCaptureProps {
  /** The conversation this surface renders — the clip's provenance identity. */
  target: ContextArtifactTarget;
  conversationName: string | null;
  /** Surface root scoping the selection listener — see the affordance. */
  within?: React.RefObject<HTMLElement | null>;
}

/**
 * The selection clip entry point, mounted once per transcript surface: wires
 * the floating Clip affordance to the foundation landing pipeline. The draft's
 * stamped metadata plus this surface's conversation identity build the same
 * `<message-ref />` copy-reference produces — compaction advertisement
 * included — and the selection's DOM-derived isCode bit decides fenced versus
 * blockquote in the fragment (D20).
 */
export default function TranscriptClipCapture({
  target,
  conversationName,
  within,
}: TranscriptClipCaptureProps): React.JSX.Element {
  const { data: artifacts } = useContextArtifacts(target, {
    staleTime: ARTIFACT_LIST_STALE_MS,
  });
  const { land } = useClipLanding(target.projectName);

  const handleClip = useCallback(
    (draft: TranscriptClipDraft) => {
      const artifact = artifacts?.find(
        (row) =>
          row.kind === "message_compaction" &&
          row.messageIndex === draft.messageIndex &&
          row.status === "complete",
      );
      const xml = buildMessageRefXml({
        projectName: target.projectName,
        sessionName: target.scope === "session" ? target.sessionName : null,
        conversationId: target.conversationId,
        conversationName,
        messageIndex: draft.messageIndex,
        role: draft.role,
        timestamp: draft.timestamp,
        model: draft.model,
        compaction: artifact
          ? { artifactId: artifact.id, createdAt: artifact.createdAt }
          : null,
      });
      void land({
        text: draft.text,
        isCode: draft.isCode,
        provenance: { kind: "ref", xml },
      });
    },
    [target, conversationName, land, artifacts],
  );

  return <TranscriptClipAffordance onClip={handleClip} within={within} />;
}
