import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  resolveQuickTicketContext,
  type QuickTicketConversationRegistration,
  type QuickTicketRouteLocation,
  type ResolvedQuickTicketContext,
} from "@/lib/tickets/quick-ticket-context";
import type {
  QuickTicketBundleKey,
  TicketWorkType,
} from "@/lib/tickets/schemas";

export interface QuickTicketDraft {
  projectName: string;
  workType: TicketWorkType;
  preBugProjectName: string | null;
  preBugWorkType: TicketWorkType | null;
  title: string;
  description: string;
  conversationAttached: boolean;
  removedBundleKeys: QuickTicketBundleKey[];
  autoStart: boolean;
  /** Auto-start kickoff overrides; null follows the configured defaults. */
  kickoffBackend: AgentBackendId | null;
  kickoffModel: string | null;
  kickoffReasoningEffort: EffortLevel | null;
}

export interface QuickTicketStoreState {
  open: boolean;
  lifecycleRevision: number;
  bugMode: boolean;
  draft: QuickTicketDraft | null;
  draftStashed: boolean;
  draftRestored: boolean;
  contextSnapshot: ResolvedQuickTicketContext | null;
  conversationRegistry: QuickTicketConversationRegistration[];
}

type QuickTicketDraftPatch = Partial<
  Omit<QuickTicketDraft, "removedBundleKeys">
>;

interface QuickTicketStoreActions {
  openQuickTicket(location: QuickTicketRouteLocation): void;
  closeQuickTicket(options: { stashDraft: boolean }): void;
  discardQuickTicketDraft(location: QuickTicketRouteLocation): void;
  clearQuickTicket(): void;
  setQuickTicketBugMode(enabled: boolean): void;
  updateQuickTicketDraft(patch: QuickTicketDraftPatch): void;
  removeQuickTicketBundleKey(key: QuickTicketBundleKey): void;
  restoreQuickTicketBundleKeys(): void;
  registerQuickTicketConversation(
    registration: QuickTicketConversationRegistration,
  ): void;
  unregisterQuickTicketConversation(token: string): void;
}

type QuickTicketStore = QuickTicketStoreState & QuickTicketStoreActions;

function createDraft(context: ResolvedQuickTicketContext): QuickTicketDraft {
  return {
    projectName: context.projectName ?? "",
    workType: "feature",
    preBugProjectName: null,
    preBugWorkType: null,
    title: "",
    description: "",
    conversationAttached: context.conversation !== undefined,
    removedBundleKeys: [],
    autoStart: false,
    kickoffBackend: null,
    kickoffModel: null,
    kickoffReasoningEffort: null,
  };
}

export function isQuickTicketDraftDirty({
  bugMode,
  draft,
  contextSnapshot,
}: Pick<
  QuickTicketStoreState,
  "bugMode" | "draft" | "contextSnapshot"
>): boolean {
  if (draft === null) return false;
  return (
    bugMode ||
    draft.title.trim().length > 0 ||
    draft.description.trim().length > 0 ||
    draft.projectName !== (contextSnapshot?.projectName ?? "") ||
    draft.workType !== "feature" ||
    draft.conversationAttached !==
      (contextSnapshot?.conversation !== undefined) ||
    draft.removedBundleKeys.length > 0 ||
    draft.autoStart
  );
}

function resetDialogState(state: QuickTicketStoreState): void {
  state.open = false;
  state.bugMode = false;
  state.draft = null;
  state.draftStashed = false;
  state.draftRestored = false;
  state.contextSnapshot = null;
}

function initializeFreshDraft(
  state: QuickTicketStoreState,
  location: QuickTicketRouteLocation,
): void {
  const context = resolveQuickTicketContext({
    ...location,
    registrations: state.conversationRegistry,
  });
  state.bugMode = false;
  state.contextSnapshot = context;
  state.draft = createDraft(context);
  state.draftStashed = false;
  state.draftRestored = false;
}

export const useQuickTicketStore = create<QuickTicketStore>()(
  immer((set) => ({
    open: false,
    lifecycleRevision: 0,
    bugMode: false,
    draft: null,
    draftStashed: false,
    draftRestored: false,
    contextSnapshot: null,
    conversationRegistry: [],

    openQuickTicket: (location) =>
      set((state) => {
        if (state.open) return;
        state.open = true;
        if (
          state.draftStashed &&
          state.draft !== null &&
          state.contextSnapshot !== null
        ) {
          state.draftStashed = false;
          state.draftRestored = true;
          return;
        }
        initializeFreshDraft(state, location);
      }),

    closeQuickTicket: ({ stashDraft }) =>
      set((state) => {
        state.lifecycleRevision += 1;
        if (stashDraft && state.draft !== null) {
          state.open = false;
          state.draftStashed = true;
          state.draftRestored = false;
          return;
        }
        resetDialogState(state);
      }),

    discardQuickTicketDraft: (location) =>
      set((state) => {
        state.lifecycleRevision += 1;
        if (!state.open) {
          resetDialogState(state);
          return;
        }
        initializeFreshDraft(state, location);
      }),

    clearQuickTicket: () =>
      set((state) => {
        state.lifecycleRevision += 1;
        resetDialogState(state);
      }),

    setQuickTicketBugMode: (enabled) =>
      set((state) => {
        state.bugMode = enabled;
      }),

    updateQuickTicketDraft: (patch) =>
      set((state) => {
        if (state.draft === null) return;
        Object.assign(state.draft, patch);
      }),

    removeQuickTicketBundleKey: (key) =>
      set((state) => {
        if (
          state.draft === null ||
          state.draft.removedBundleKeys.includes(key)
        ) {
          return;
        }
        state.draft.removedBundleKeys.push(key);
        if (key === "conversation") {
          state.draft.conversationAttached = false;
        }
      }),

    restoreQuickTicketBundleKeys: () =>
      set((state) => {
        if (state.draft === null) return;
        state.draft.removedBundleKeys = [];
        state.draft.conversationAttached =
          state.contextSnapshot?.conversation !== undefined;
      }),

    registerQuickTicketConversation: (registration) =>
      set((state) => {
        const existingIndex = state.conversationRegistry.findIndex(
          (candidate) => candidate.token === registration.token,
        );
        if (existingIndex !== -1) {
          state.conversationRegistry.splice(existingIndex, 1);
        }
        state.conversationRegistry.push({ ...registration });
      }),

    unregisterQuickTicketConversation: (token) =>
      set((state) => {
        const index = state.conversationRegistry.findIndex(
          (registration) => registration.token === token,
        );
        if (index !== -1) state.conversationRegistry.splice(index, 1);
      }),
  })),
);
