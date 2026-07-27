import {
  type InFlightSlice,
  type SessionDetailSliceCreator,
  agentSettingsStamp,
  ensureInFlight,
  initialState,
} from "./types";

/**
 * Timers that auto-clear the transient `promptCancelled` flag. Module-scoped so
 * `resetStore` can cancel every pending one — see `clearAllCancelledTimers`.
 */
const cancelledTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function clearAllCancelledTimers(): void {
  for (const timer of cancelledTimers.values()) clearTimeout(timer);
  cancelledTimers.clear();
}

export const createInFlightSlice: SessionDetailSliceCreator<InFlightSlice> = (
  set,
  get,
) => ({
  inFlight: initialState.inFlight,

  submitPrompt: (
    conversationId,
    userContent,
    currentMessageCount,
    agentSettings,
  ) =>
    set((state) => {
      const entry = ensureInFlight(state, conversationId);
      entry.sending = true;
      entry.promptError = null;
      entry.messageCountBeforeSubmit = currentMessageCount;
      entry.optimisticMessages = [
        {
          role: "user",
          content: userContent,
          timestamp: new Date().toISOString(),
          ...agentSettingsStamp(agentSettings),
        },
      ];
    }),

  receiveStreamContent: (
    conversationId,
    userContent,
    allBlocks,
    agentSettings,
  ) =>
    set((state) => {
      const entry = ensureInFlight(state, conversationId);
      // Preserve any queued user messages appended after the initial pair
      const queued = entry.optimisticMessages.slice(2);
      entry.optimisticMessages = [
        {
          role: "user",
          content: userContent,
          timestamp: new Date().toISOString(),
          ...agentSettingsStamp(agentSettings),
        },
        {
          role: "assistant",
          content: [...allBlocks],
          timestamp: new Date().toISOString(),
          ...agentSettingsStamp(agentSettings),
        },
        ...queued,
      ];
    }),

  completePrompt: (conversationId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.sending = false;
    }),

  failPrompt: (conversationId, error) =>
    set((state) => {
      const entry = ensureInFlight(state, conversationId);
      entry.promptError = error;
      entry.sending = false;
    }),

  // Surface a queue failure to the user WITHOUT clearing `sending`: a queue
  // POST failing must leave the still-running turn shown as running (req 5.2)
  // while the error is visible (req 5.1). Distinct from `failPrompt`, which
  // also stops the running indicator.
  setQueueError: (conversationId, error) =>
    set((state) => {
      ensureInFlight(state, conversationId).promptError = error;
    }),

  queueMessage: (conversationId, userContent) =>
    set((state) => {
      ensureInFlight(state, conversationId).optimisticMessages.push({
        role: "user",
        content: userContent,
        timestamp: new Date().toISOString(),
      });
    }),

  // -- Optimistic queue --
  // Mutate ONLY optimisticQueue. The running/sending flag must never change
  // here: a queue failure must leave a still-running turn shown as running
  // (req 5.2) while removing the optimistic entry (req 5.3).

  addOptimisticQueueEntry: (conversationId, tempId, content) =>
    set((state) => {
      ensureInFlight(state, conversationId).optimisticQueue.push({
        tempId,
        queueId: null,
        content,
        status: "pending",
      });
    }),

  acceptOptimisticQueueEntry: (conversationId, tempId, queueId) =>
    set((state) => {
      const inFlight = state.inFlight[conversationId];
      if (!inFlight) return;
      const index = inFlight.optimisticQueue.findIndex(
        (e) => e.tempId === tempId,
      );
      if (index === -1) return;

      // The row this entry is adopting may already have been delivered — the
      // in-turn delivery path settles it before the enqueue response is
      // written. Adopting the id would resurrect the entry as pending beside
      // the transcript row it has already become, so it retires instead.
      const settledIndex = inFlight.settledQueueIds.indexOf(queueId);
      if (settledIndex !== -1) {
        inFlight.settledQueueIds.splice(settledIndex, 1);
        inFlight.optimisticQueue.splice(index, 1);
        return;
      }

      const entry = inFlight.optimisticQueue[index];
      if (!entry) return;
      entry.queueId = queueId;
      entry.status = "accepted";
    }),

  settleOptimisticQueueEntry: (conversationId, queueId) =>
    set((state) => {
      const inFlight = state.inFlight[conversationId];
      if (!inFlight) return;

      const remaining = inFlight.optimisticQueue.filter(
        (e) => e.queueId !== queueId,
      );
      if (remaining.length !== inFlight.optimisticQueue.length) {
        inFlight.optimisticQueue = remaining;
        return;
      }

      // No entry carries this id yet. Remember it only while an enqueue is
      // still awaiting its server id — that entry may be the one this row
      // belongs to. With nothing left to adopt it, the row is another client's
      // (or another tab's) and there is nothing here to reconcile.
      const awaitingId = inFlight.optimisticQueue.some(
        (e) => e.queueId === null,
      );
      if (awaitingId && !inFlight.settledQueueIds.includes(queueId)) {
        inFlight.settledQueueIds.push(queueId);
      }
    }),

  failOptimisticQueueEntry: (conversationId, tempId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.optimisticQueue = entry.optimisticQueue.filter(
        (e) => e.tempId !== tempId,
      );
    }),

  resolveOptimisticQueueEntries: (conversationId, queueIds) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      const resolved = new Set(queueIds);
      entry.optimisticQueue = entry.optimisticQueue.filter(
        (e) => e.queueId === null || !resolved.has(e.queueId),
      );
    }),

  cancelOptimisticQueueEntry: (conversationId, idOrTempId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.optimisticQueue = entry.optimisticQueue.filter(
        (e) => e.tempId !== idOrTempId && e.queueId !== idOrTempId,
      );
    }),

  rollbackOptimisticQueueEntry: (conversationId, tempId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.optimisticQueue = entry.optimisticQueue.filter(
        (e) => e.tempId !== tempId,
      );
    }),

  dismissError: (conversationId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.promptError = null;
    }),

  markCancelled: (conversationId) => {
    const existing = cancelledTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    set((state) => {
      ensureInFlight(state, conversationId).promptCancelled = true;
    });
    cancelledTimers.set(
      conversationId,
      setTimeout(() => {
        cancelledTimers.delete(conversationId);
        set((state) => {
          const entry = state.inFlight[conversationId];
          if (!entry) return;
          entry.promptCancelled = false;
        });
      }, 2500),
    );
  },

  dismissCancelled: (conversationId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.promptCancelled = false;
    }),

  reconcileMessages: (conversationId, serverCount) => {
    const entry = get().inFlight[conversationId];
    if (!entry || entry.optimisticMessages.length === 0) return;
    if (serverCount <= entry.messageCountBeforeSubmit) return;

    // Server has the prompt data — clear all optimistic messages.
    // (This is only called when sending=false, so the stream is done.)
    set((state) => {
      const target = state.inFlight[conversationId];
      if (!target) return;
      target.optimisticMessages = [];
    });
  },

  clearConversationMessages: (conversationId) =>
    set((state) => {
      const entry = state.inFlight[conversationId];
      if (!entry) return;
      entry.optimisticMessages = [];
      entry.messageCountBeforeSubmit = 0;
    }),

  reassignInFlight: (fromConversationId, toConversationId) =>
    set((state) => {
      const entry = state.inFlight[fromConversationId];
      if (!entry) return;
      state.inFlight[toConversationId] = entry;
      delete state.inFlight[fromConversationId];
    }),

  discardInFlight: (conversationId) =>
    set((state) => {
      delete state.inFlight[conversationId];
    }),
});
