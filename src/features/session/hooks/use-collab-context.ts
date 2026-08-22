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
import {
  asCollaborationAgent,
  type CollaborationAgent,
  type CollaborationReference,
} from "@/lib/workflows/collaboration/types";
import type {
  PublicConversationState,
  TranscriptMessage,
} from "@/lib/conversations/schemas";
import type { CollaborationEnvelope } from "@/lib/collaboration/schemas";
import { seedAgentTwoDraft } from "@/stores/collaboration.store";
import type { BackendSelectionDefaultsById } from "@/lib/agent-backends/catalog";

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
  /** Per-backend selection defaults that seed Agent Two's draft config. */
  backendDefaults: BackendSelectionDefaultsById;
}

export function useCollabContext({
  projectName,
  sessionName,
  conversationId,
  collaborationListQuery,
  activeConversation,
  rawMessages,
  openDocById,
  backendDefaults,
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
  // Null when the conversation's backend cannot take a lane — the signal
  // PromptComposer gates the /collab row on. Naming a backend the conversation
  // is not running would show the row with the wrong Agent One AND send a start
  // request that adopts that backend onto the conversation.
  const originatingCollabAgent: CollaborationAgent | null =
    activeConversation === undefined
      ? null
      : asCollaborationAgent(activeConversation.agentBackend);
  // Agent Two's draft seeds lazily so the default tracks the conversation's
  // backend: the suggested backend is the opposite of Agent One's (an explicit
  // same-backend choice is fine), and model/effort/fastMode seed from the
  // global per-backend selection defaults so what the row shows is what the
  // start request sends.
  const effectiveCollabConfig = useMemo(() => {
    const agentTwo =
      collabConfigDraft.agentTwo ??
      seedAgentTwoDraft(
        // The suggested partner is the opposite of Agent One. With no Agent One
        // the row does not render at all, so the seed is inert.
        originatingCollabAgent === "codex" ? "claude" : "codex",
        backendDefaults,
      );
    return { ...collabConfigDraft, agentTwo };
  }, [collabConfigDraft, originatingCollabAgent, backendDefaults]);

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
