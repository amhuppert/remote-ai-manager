"use client";

import { useCallback, type Dispatch, type SetStateAction } from "react";
import CollabPassage, {
  isCollabPassageTerminal,
} from "@/features/session/conversation/collab/CollabPassage";
import type { CollaborationReference } from "@/lib/workflows/collaboration/types";
import type { ConversationVirtuosoListProps } from "@/components/conversation/ConversationVirtuosoList";

type CollabPassageProps = Parameters<typeof CollabPassage>[0];

interface CollaborationEnvelope {
  workflowId: string;
  status: "running" | "paused" | "completed" | "failed";
  phase: string;
  featureSnapshot: unknown;
  errorSummary?: string;
  pause?: {
    pauseKind: string;
    gateKind: string;
    resumeToken: string;
    reason?: string;
  };
}

export interface UseCollabRowRendererArgs {
  collabPassageProps: CollabPassageProps | null;
  collabEnvelopeForConversation: CollaborationEnvelope | undefined;
  isCollabRunning: boolean;
  collabPinnedTopTarget: HTMLDivElement | null;
  setCollabRowEl: Dispatch<SetStateAction<HTMLDivElement | null>>;
  handleCollabStop: () => void;
  handleCollabRefClick: (ref: CollaborationReference) => void;
  projectName: string;
  sessionName: string;
  conversationId: string;
  collabUserAnswerDrafts: Record<string, string>;
  setCollabUserAnswerDraft: (
    project: string,
    session: string,
    workflowId: string,
    question: string,
    value: string,
  ) => void;
  clearCollabUserAnswerDrafts: (
    project: string,
    session: string,
    workflowId: string,
  ) => void;
  collabResumeMutation: {
    isPending: boolean;
    mutate: (
      input: {
        resumeToken: string;
        conversationId: string;
        userAnswers: Record<string, string>;
      },
      options: { onSuccess: () => void },
    ) => void;
  };
}

export function useCollabRowRenderer({
  collabPassageProps,
  collabEnvelopeForConversation,
  isCollabRunning,
  collabPinnedTopTarget,
  setCollabRowEl,
  handleCollabStop,
  handleCollabRefClick,
  projectName,
  sessionName,
  conversationId,
  collabUserAnswerDrafts,
  setCollabUserAnswerDraft,
  clearCollabUserAnswerDrafts,
  collabResumeMutation,
}: UseCollabRowRendererArgs): ConversationVirtuosoListProps["renderCollab"] {
  return useCallback<ConversationVirtuosoListProps["renderCollab"]>(() => {
    if (!collabPassageProps || !collabEnvelopeForConversation) return null;
    return (
      <div ref={setCollabRowEl} data-collab-row="true">
        <CollabPassage
          {...collabPassageProps}
          projectName={projectName}
          sessionName={sessionName}
          onStop={handleCollabStop}
          hideInlinePhaseStrip={isCollabRunning}
          pinnedTopTarget={collabPinnedTopTarget}
          pauseHandlers={
            collabEnvelopeForConversation.status === "paused" &&
            collabEnvelopeForConversation.pause?.resumeToken
              ? {
                  drafts: collabUserAnswerDrafts,
                  onDraftChange: (q, value) =>
                    setCollabUserAnswerDraft(
                      projectName,
                      sessionName,
                      collabEnvelopeForConversation.workflowId,
                      q,
                      value,
                    ),
                  onSubmit: () => {
                    const resumeToken =
                      collabEnvelopeForConversation.pause!.resumeToken;
                    const userAnswers: Record<string, string> = {};
                    for (const [k, v] of Object.entries(
                      collabUserAnswerDrafts,
                    )) {
                      if (typeof v === "string" && v.trim().length > 0) {
                        userAnswers[k] = v.trim();
                      }
                    }
                    collabResumeMutation.mutate(
                      {
                        resumeToken,
                        conversationId,
                        userAnswers,
                      },
                      {
                        onSuccess: () => {
                          clearCollabUserAnswerDrafts(
                            projectName,
                            sessionName,
                            collabEnvelopeForConversation.workflowId,
                          );
                        },
                      },
                    );
                  },
                  isSubmitting: collabResumeMutation.isPending,
                }
              : undefined
          }
          onRefClick={handleCollabRefClick}
        />
      </div>
    );
  }, [
    clearCollabUserAnswerDrafts,
    collabEnvelopeForConversation,
    collabPassageProps,
    collabPinnedTopTarget,
    collabResumeMutation,
    collabUserAnswerDrafts,
    conversationId,
    handleCollabRefClick,
    handleCollabStop,
    isCollabRunning,
    projectName,
    sessionName,
    setCollabRowEl,
    setCollabUserAnswerDraft,
  ]);
}

export { isCollabPassageTerminal };
