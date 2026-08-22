/**
 * Collaboration Mode UI store.
 *
 * Holds ephemeral client-side UI state for the inline `/collab` flow only:
 *
 *  - per-question answer drafts when a paused workflow is awaiting user input
 *  - per-conversation `/collab` config drafts (second agent, max rounds, etc.)
 *
 * Durable workflow state (envelope status, lifecycle phase, artifacts) lives
 * server-side in `WorkflowEnvelopeStore` and is fetched via TanStack Query.
 * This store deliberately stays narrow so a stale draft does not survive a
 * page reload (in-memory only) and so a round-trip refetch is the source of
 * truth for everything the slice owns.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import {
  backendSupportsFastMode,
  type BackendSelectionDefaultsById,
} from "@/lib/agent-backends/catalog";
import { deepEqualJson } from "@/lib/shared/deep-equal";
import type { CollaborationAgent } from "@/lib/workflows/collaboration/types";

type CollabAgent = CollaborationAgent;

type CollabAutonomousResolutionThreshold =
  | "none"
  | "minor"
  | "major"
  | "blocking";

/**
 * Agent Two's draft configuration. Fully concrete once the config row seeds
 * it (backend defaults to the opposite of Agent One's; model/effort/fastMode
 * seed from the global per-backend selection defaults), so what the user sees
 * is exactly what the start request sends.
 */
export interface CollabAgentTwoDraft {
  backend: CollabAgent;
  model?: string;
  effort?: string;
  fastMode?: boolean;
  /** Compact `tier:id` agent-profile selection. */
  profile?: string;
}

export interface CollabConfigDraft {
  /**
   * Absent until seeded for the active conversation — the effective config
   * derives the default from the originating agent's backend, so the stored
   * default cannot go stale against a backend switch.
   */
  agentTwo?: CollabAgentTwoDraft;
  negotiationRounds: number;
  autonomousResolutionThreshold: CollabAutonomousResolutionThreshold;
}

interface CollaborationState {
  /**
   * Per-(session,workflow,question) user-answer drafts. Outer key is
   * `${projectName}::${sessionName}::${workflowId}`; inner record maps
   * questionId → draft answer text.
   */
  userAnswerDraftsByWorkflow: Record<string, Record<string, string>>;
  /**
   * Per-conversation `/collab` config drafts. Keyed by
   * `${projectName}::${sessionName}::${conversationId}` so opening a
   * different conversation gets a fresh draft.
   */
  collabConfigDraftsByConversation: Record<string, CollabConfigDraft>;
}

interface CollaborationActions {
  setUserAnswerDraft(
    projectName: string,
    sessionName: string,
    workflowId: string,
    questionId: string,
    answer: string,
  ): void;
  clearUserAnswerDrafts(
    projectName: string,
    sessionName: string,
    workflowId: string,
  ): void;
  setCollabConfigDraft(
    projectName: string,
    sessionName: string,
    conversationId: string,
    draft: CollabConfigDraft,
  ): void;
  clearCollabConfigDraft(
    projectName: string,
    sessionName: string,
    conversationId: string,
  ): void;
  clearCollabConfigDraftIfMatches(
    projectName: string,
    sessionName: string,
    conversationId: string,
    expectedDraft: CollabConfigDraft,
  ): void;
}

type CollaborationStore = CollaborationState & CollaborationActions;

export const DEFAULT_COLLAB_CONFIG_DRAFT: CollabConfigDraft = {
  negotiationRounds: 3,
  autonomousResolutionThreshold: "major",
};

/**
 * The `/collab` config with Agent Two's draft resolved — what the config row
 * renders and the start request is built from.
 */
export type EffectiveCollabConfig = CollabConfigDraft & {
  agentTwo: CollabAgentTwoDraft;
};

/**
 * A fully concrete Agent Two draft from the given backend's defaults. The
 * parameter is a collaboration agent, not any registered backend: a lane can
 * only be seeded for a backend the flow actually runs.
 */
export function seedAgentTwoDraft(
  backend: CollabAgent,
  backendDefaults: BackendSelectionDefaultsById,
): CollabAgentTwoDraft {
  const defaults = backendDefaults[backend];
  return {
    backend,
    model: defaults.modelId,
    effort: defaults.effort,
    ...(backendSupportsFastMode(backend)
      ? { fastMode: defaults.codexFastMode ?? false }
      : {}),
  };
}

function workflowKey(
  projectName: string,
  sessionName: string,
  workflowId: string,
): string {
  return `${projectName}::${sessionName}::${workflowId}`;
}

function conversationKey(
  projectName: string,
  sessionName: string,
  conversationId: string,
): string {
  return `${projectName}::${sessionName}::${conversationId}`;
}

export const useCollaborationStore = create<CollaborationStore>()(
  immer((set) => ({
    userAnswerDraftsByWorkflow: {},
    collabConfigDraftsByConversation: {},

    setUserAnswerDraft: (
      projectName,
      sessionName,
      workflowId,
      questionId,
      answer,
    ) =>
      set((state) => {
        const key = workflowKey(projectName, sessionName, workflowId);
        const existing = state.userAnswerDraftsByWorkflow[key] ?? {};
        state.userAnswerDraftsByWorkflow[key] = {
          ...existing,
          [questionId]: answer,
        };
      }),

    clearUserAnswerDrafts: (projectName, sessionName, workflowId) =>
      set((state) => {
        const key = workflowKey(projectName, sessionName, workflowId);
        delete state.userAnswerDraftsByWorkflow[key];
      }),

    setCollabConfigDraft: (projectName, sessionName, conversationId, draft) =>
      set((state) => {
        const key = conversationKey(projectName, sessionName, conversationId);
        state.collabConfigDraftsByConversation[key] = draft;
      }),

    clearCollabConfigDraft: (projectName, sessionName, conversationId) =>
      set((state) => {
        const key = conversationKey(projectName, sessionName, conversationId);
        delete state.collabConfigDraftsByConversation[key];
      }),

    clearCollabConfigDraftIfMatches: (
      projectName,
      sessionName,
      conversationId,
      expectedDraft,
    ) =>
      set((state) => {
        const key = conversationKey(projectName, sessionName, conversationId);
        const currentDraft = state.collabConfigDraftsByConversation[key];
        if (!deepEqualJson(currentDraft, expectedDraft)) return;
        delete state.collabConfigDraftsByConversation[key];
      }),
  })),
);

// Stable empty-record sentinel so subscribers don't get a new reference each
// time their workflow has no drafts.
const EMPTY_ANSWER_DRAFTS: Record<string, string> = Object.freeze({});

export const useUserAnswerDrafts = (
  projectName: string,
  sessionName: string,
  workflowId: string,
): Record<string, string> => {
  const key = workflowKey(projectName, sessionName, workflowId);
  return useCollaborationStore(
    (s) => s.userAnswerDraftsByWorkflow[key] ?? EMPTY_ANSWER_DRAFTS,
  );
};

export const useCollabConfigDraft = (
  projectName: string,
  sessionName: string,
  conversationId: string,
): CollabConfigDraft => {
  const key = conversationKey(projectName, sessionName, conversationId);
  return useCollaborationStore(
    (s) =>
      s.collabConfigDraftsByConversation[key] ?? DEFAULT_COLLAB_CONFIG_DRAFT,
  );
};

export const useSetUserAnswerDraft = () =>
  useCollaborationStore((s) => s.setUserAnswerDraft);
export const useClearUserAnswerDrafts = () =>
  useCollaborationStore((s) => s.clearUserAnswerDrafts);
export const useSetCollabConfigDraft = () =>
  useCollaborationStore((s) => s.setCollabConfigDraft);
export const useClearCollabConfigDraft = () =>
  useCollaborationStore((s) => s.clearCollabConfigDraft);
export const useClearCollabConfigDraftIfMatches = () =>
  useCollaborationStore((s) => s.clearCollabConfigDraftIfMatches);
