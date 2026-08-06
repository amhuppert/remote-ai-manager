"use client";

import { useCallback, useMemo } from "react";
import {
  useCollaborationStopMutation,
  useCollaborationResumeMutation,
} from "@/lib/workflows/mutations";
import { useReferenceDocumentsQuery } from "@/lib/reference-documents/queries";
import {
  useCollabConfigDraft,
  useSetCollabConfigDraft,
  useClearCollabConfigDraft,
  useUserAnswerDrafts,
  useSetUserAnswerDraft,
  useClearUserAnswerDrafts,
} from "@/stores/collaboration.store";
import { isCollabPassageTerminal } from "@/features/session/conversation/collab/CollabPassage";
import { envelopeToCollabPassageProps } from "@/features/session/conversation/collab/envelope-adapter";
import { resolveRefToDocumentId } from "@/features/session/conversation/collab/ref-resolver";
import {
  findActiveCollab,
  findCollabEnvelopeForConversation,
  findCollabFinalDuplicateIndex,
  latestFinalAnswerText,
} from "@/features/session/conversation/collab/page-helpers";
import type { CollaborationReference } from "@/lib/workflows/collaboration/types";
import type {
  PublicConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { CollaborationEnvelope } from "@/lib/collaboration/schemas";

interface CollaborationListQueryResult {
  data: readonly CollaborationEnvelope[] | undefined;
}

export interface UseCollabContextArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
  collaborationListQuery: CollaborationListQueryResult;
  activeConversation: PublicConversationState | undefined;
  rawMessages: readonly TranscriptMessage[];
  openDocById: (docId: string) => void;
}

export function useCollabContext({
  projectName,
  sessionName,
  conversationId,
  collaborationListQuery,
  activeConversation,
  rawMessages,
  openDocById,
}: UseCollabContextArgs) {
  const activeCollabEnvelope = findActiveCollab(
    collaborationListQuery.data,
    conversationId,
  );
  const collabEnvelopeForConversation = findCollabEnvelopeForConversation(
    collaborationListQuery.data,
    conversationId,
  );
  const hasActiveCollab = activeCollabEnvelope !== undefined;

  const workflowId = collabEnvelopeForConversation?.workflowId ?? "";
  const collabResumeMutation = useCollaborationResumeMutation(
    projectName,
    sessionName,
    workflowId,
  );
  const collabStopMutation = useCollaborationStopMutation(
    projectName,
    sessionName,
    workflowId,
  );
  const handleCollabStop = useCallback(() => {
    if (!collabEnvelopeForConversation) return;
    collabStopMutation.mutate({ conversationId });
  }, [collabEnvelopeForConversation, collabStopMutation, conversationId]);

  const collabUserAnswerDrafts = useUserAnswerDrafts(
    projectName,
    sessionName,
    workflowId,
  );
  const setCollabUserAnswerDraft = useSetUserAnswerDraft();
  const clearCollabUserAnswerDrafts = useClearUserAnswerDrafts();

  const collabPassageProps = useMemo(
    () =>
      collabEnvelopeForConversation
        ? envelopeToCollabPassageProps({
            workflowId: collabEnvelopeForConversation.workflowId,
            status: collabEnvelopeForConversation.status,
            phase: collabEnvelopeForConversation.phase,
            featureSnapshot: collabEnvelopeForConversation.featureSnapshot,
            ...(collabEnvelopeForConversation.errorSummary !== undefined
              ? { errorSummary: collabEnvelopeForConversation.errorSummary }
              : {}),
          })
        : null,
    [collabEnvelopeForConversation],
  );
  const collabPassageStatus = collabPassageProps?.status ?? null;
  const isCollabRunning =
    collabPassageStatus !== null &&
    !isCollabPassageTerminal(collabPassageStatus);
  const collabFinalAnswerText =
    collabPassageProps && isCollabPassageTerminal(collabPassageProps.status)
      ? latestFinalAnswerText(collabPassageProps.artifacts)
      : null;

  const hiddenMessageIndex = useMemo(
    () => findCollabFinalDuplicateIndex(rawMessages, collabFinalAnswerText),
    [rawMessages, collabFinalAnswerText],
  );

  const referenceDocumentsQuery = useReferenceDocumentsQuery(
    projectName,
    sessionName,
  );
  const referenceDocuments = useMemo(
    () => referenceDocumentsQuery.data ?? [],
    [referenceDocumentsQuery.data],
  );
  const handleCollabRefClick = useCallback(
    (ref: CollaborationReference) => {
      const docId = resolveRefToDocumentId(ref.artifact, referenceDocuments);
      if (docId) {
        openDocById(docId);
      }
    },
    [referenceDocuments, openDocById],
  );

  const collabConfigDraft = useCollabConfigDraft(
    projectName,
    sessionName,
    conversationId,
  );
  const setCollabConfigDraft = useSetCollabConfigDraft();
  const clearCollabConfigDraft = useClearCollabConfigDraft();
  const originatingCollabAgent: "claude" | "codex" =
    activeConversation?.agentBackend === "codex" ? "codex" : "claude";
  const effectiveCollabConfig = useMemo(
    () =>
      collabConfigDraft.secondAgent === originatingCollabAgent
        ? {
            ...collabConfigDraft,
            secondAgent:
              originatingCollabAgent === "claude"
                ? ("codex" as const)
                : ("claude" as const),
          }
        : collabConfigDraft,
    [collabConfigDraft, originatingCollabAgent],
  );

  return {
    collabEnvelopeForConversation,
    hasActiveCollab,
    collabResumeMutation,
    handleCollabStop,
    collabUserAnswerDrafts,
    setCollabUserAnswerDraft,
    clearCollabUserAnswerDrafts,
    collabPassageProps,
    isCollabRunning,
    hiddenMessageIndex,
    handleCollabRefClick,
    originatingCollabAgent,
    effectiveCollabConfig,
    setCollabConfigDraft,
    clearCollabConfigDraft,
  };
}
