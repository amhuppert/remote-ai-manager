"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  useUpdatePendingPromptTextMutation,
  sendPendingPromptBeacon,
} from "@/lib/prompt/mutations";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { ConversationTarget } from "@/lib/conversations/conversation-target";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { deserializePromptDoc } from "@/lib/prompt-editor";

const DEBOUNCE_MS = 500;
const logger = createClientLogger("pending-prompt-persistence");

export interface UsePendingPromptPersistenceArgs {
  /**
   * The conversation whose draft this composer owns, or null on the project
   * cockpit's create-and-send path where no conversation exists yet. Must be
   * referentially stable (memoize at the call site) — the flush and beacon
   * effects key off it.
   */
  target: ConversationTarget | null;
  activeConversation: ConversationState | undefined;
  promptText: string;
  setPromptText: (text: string) => void;
  promptTextRef: MutableRefObject<string>;
  editorRef: MutableRefObject<PromptEditorHandle | null>;
}

export interface UsePendingPromptPersistenceResult {
  handlePromptTextChange: (next: string) => void;
  suppressPendingPromptAutosaveAfterSubmit: () => void;
}

/**
 * Durable, conversation-local prompt drafts for a conversation of EITHER scope.
 * The draft lives on the conversation record (`pendingPromptText`), so switching
 * conversations cannot move it and a page reload restores it. Scope enters only
 * as the `ConversationTarget` the caller supplies; everything below — the
 * hydration gate, the debounce, the switch flush, the unload beacon — is the
 * same behaviour for both.
 */
export function usePendingPromptPersistence({
  target,
  activeConversation,
  promptText,
  setPromptText,
  promptTextRef,
  editorRef,
}: UsePendingPromptPersistenceArgs): UsePendingPromptPersistenceResult {
  const conversationId = target?.conversationId ?? null;
  const updatePendingPromptMutation = useUpdatePendingPromptTextMutation(target);
  const updatePendingPromptMutate = updatePendingPromptMutation.mutate;
  const hydratedConversationIdRef = useRef<string | null>(null);
  const lastPersistedPendingPromptRef = useRef<string | null>(null);
  const pendingPromptSaveTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const persistPendingPromptText = useCallback(
    (text: string | null) => {
      if (target === null) return;
      if (lastPersistedPendingPromptRef.current === text) return;
      lastPersistedPendingPromptRef.current = text;
      updatePendingPromptMutate({ target, text });
    },
    [updatePendingPromptMutate, target],
  );

  const cancelPendingPromptDebounce = useCallback(() => {
    if (pendingPromptSaveTimerRef.current !== null) {
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
    }
  }, []);

  // Fire the pending debounced save immediately for the given target. Used on
  // conversation switch and unmount so drafts survive fast navigation before the
  // 500ms debounce fires.
  const flushPendingPromptText = useCallback(
    (capturedTarget: ConversationTarget) => {
      if (pendingPromptSaveTimerRef.current === null) return;
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      lastPersistedPendingPromptRef.current = normalized;
      updatePendingPromptMutate({ target: capturedTarget, text: normalized });
    },
    [updatePendingPromptMutate, promptTextRef],
  );

  const suppressPendingPromptAutosaveAfterSubmit = useCallback(() => {
    cancelPendingPromptDebounce();
    if (target === null) return;
    const expectedText = lastPersistedPendingPromptRef.current;
    lastPersistedPendingPromptRef.current = null;
    updatePendingPromptMutate({
      target,
      text: null,
      ...(expectedText !== null ? { expectedText } : {}),
    });
    logger.debug("pending_prompt.submit_clear_requested", {
      ...target,
      compareAndClear: expectedText !== null,
    });
  }, [cancelPendingPromptDebounce, updatePendingPromptMutate, target]);

  // --- Reset hydration gate when switching conversations ---
  useEffect(() => {
    hydratedConversationIdRef.current = null;
    lastPersistedPendingPromptRef.current = null;
    cancelPendingPromptDebounce();
  }, [conversationId, cancelPendingPromptDebounce]);

  // --- Hydrate prompt input from conversation.pendingPromptText (once per
  // conversation switch) ---
  // The Tiptap editor inside <PromptEditor> only consumes `value` as its
  // initial content, so we also push into the editor instance imperatively
  // for the case where the editor mounts before the conversation data
  // arrives.
  useEffect(() => {
    if (conversationId === null) return;
    if (!activeConversation) return;
    if (hydratedConversationIdRef.current === conversationId) return;

    const initial = activeConversation.pendingPromptText ?? "";
    hydratedConversationIdRef.current = conversationId;
    lastPersistedPendingPromptRef.current = activeConversation.pendingPromptText;
    setPromptText(initial);
    const editorInstance = editorRef.current?.editor;
    if (editorInstance) {
      if (initial.length > 0) {
        editorInstance.commands.setContent(
          deserializePromptDoc({ prompt: initial, images: [] }),
        );
      } else {
        editorInstance.commands.clearContent(true);
      }
    }
  }, [conversationId, activeConversation, setPromptText, editorRef]);

  // If the user starts typing before activeConversation has loaded, mark
  // hydration as complete so the hydration effect above doesn't later
  // overwrite their input when data arrives. The user's text is the source
  // of truth; whatever was persisted will be overwritten by the next
  // debounced save.
  const handlePromptTextChange = useCallback(
    (next: string) => {
      if (
        conversationId !== null &&
        hydratedConversationIdRef.current !== conversationId
      ) {
        hydratedConversationIdRef.current = conversationId;
      }
      setPromptText(next);
    },
    [conversationId, setPromptText],
  );

  // --- Flush pending debounced save on conversation switch / unmount ---
  // The cleanup function captures the previous target, so when the user
  // navigates away or switches conversations before the 500ms debounce timer
  // fires, the in-flight draft is still POSTed to the server and will be
  // restored on next mount.
  useEffect(() => {
    if (target === null) return;
    const capturedTarget = target;
    return () => {
      flushPendingPromptText(capturedTarget);
    };
  }, [target, flushPendingPromptText]);

  // --- Flush pending debounced save on full page reload via sendBeacon ---
  // The regular fetch from useMutation may be aborted when the page unloads,
  // so we use navigator.sendBeacon (which is delivery-guaranteed on unload)
  // to flush any pending draft. The URL and payload format are shared with
  // the mutation hook via `sendPendingPromptBeacon`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (target === null) return;
    const handleBeforeUnload = () => {
      if (pendingPromptSaveTimerRef.current === null) return;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      if (sendPendingPromptBeacon(target, normalized)) {
        lastPersistedPendingPromptRef.current = normalized;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [target, promptTextRef]);

  // --- Debounced save of typed prompt text ---
  useEffect(() => {
    if (conversationId === null) return;
    if (hydratedConversationIdRef.current !== conversationId) return;

    const normalized = promptText === "" ? null : promptText;
    if (normalized === lastPersistedPendingPromptRef.current) return;

    cancelPendingPromptDebounce();
    pendingPromptSaveTimerRef.current = setTimeout(() => {
      pendingPromptSaveTimerRef.current = null;
      persistPendingPromptText(normalized);
    }, DEBOUNCE_MS);

    return cancelPendingPromptDebounce;
  }, [
    promptText,
    conversationId,
    persistPendingPromptText,
    cancelPendingPromptDebounce,
  ]);

  return {
    handlePromptTextChange,
    suppressPendingPromptAutosaveAfterSubmit,
  };
}
