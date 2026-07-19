"use client";

import { useCallback, useEffect, useRef, type MutableRefObject } from "react";
import {
  useUpdatePendingPromptTextMutation,
  sendPendingPromptBeacon,
} from "@/lib/prompt/mutations";
import { createClientLogger } from "@/lib/logging/client-logger";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { PromptEditorHandle } from "@/components/session/prompt/PromptEditor";
import { deserializePromptDoc } from "@/lib/prompt-editor";

const DEBOUNCE_MS = 500;
const logger = createClientLogger("pending-prompt-persistence");

export interface UsePendingPromptPersistenceArgs {
  projectName: string;
  sessionName: string;
  conversationId: string;
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

export function usePendingPromptPersistence({
  projectName,
  sessionName,
  conversationId,
  activeConversation,
  promptText,
  setPromptText,
  promptTextRef,
  editorRef,
}: UsePendingPromptPersistenceArgs): UsePendingPromptPersistenceResult {
  const updatePendingPromptMutation = useUpdatePendingPromptTextMutation(
    projectName,
    sessionName,
    conversationId,
  );
  const updatePendingPromptMutate = updatePendingPromptMutation.mutate;
  const hydratedConversationIdRef = useRef<string | null>(null);
  const lastPersistedPendingPromptRef = useRef<string | null>(null);
  const pendingPromptSaveTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const persistPendingPromptText = useCallback(
    (text: string | null) => {
      if (lastPersistedPendingPromptRef.current === text) return;
      lastPersistedPendingPromptRef.current = text;
      updatePendingPromptMutate({ conversationId, text });
    },
    [updatePendingPromptMutate, conversationId],
  );

  const cancelPendingPromptDebounce = useCallback(() => {
    if (pendingPromptSaveTimerRef.current !== null) {
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
    }
  }, []);

  // Fire the pending debounced save immediately for the given conversationId.
  // Used on conversation switch and unmount so drafts survive fast navigation
  // before the 500ms debounce fires.
  const flushPendingPromptText = useCallback(
    (capturedConversationId: string) => {
      if (pendingPromptSaveTimerRef.current === null) return;
      clearTimeout(pendingPromptSaveTimerRef.current);
      pendingPromptSaveTimerRef.current = null;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      lastPersistedPendingPromptRef.current = normalized;
      updatePendingPromptMutate({
        conversationId: capturedConversationId,
        text: normalized,
      });
    },
    [updatePendingPromptMutate, promptTextRef],
  );

  const suppressPendingPromptAutosaveAfterSubmit = useCallback(() => {
    cancelPendingPromptDebounce();
    const expectedText = lastPersistedPendingPromptRef.current;
    lastPersistedPendingPromptRef.current = null;
    updatePendingPromptMutate({
      conversationId,
      text: null,
      ...(expectedText !== null ? { expectedText } : {}),
    });
    logger.debug("pending_prompt.submit_clear_requested", {
      projectName,
      sessionName,
      conversationId,
      compareAndClear: expectedText !== null,
    });
  }, [
    cancelPendingPromptDebounce,
    updatePendingPromptMutate,
    conversationId,
    projectName,
    sessionName,
  ]);

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
    if (!activeConversation) return;
    if (hydratedConversationIdRef.current === conversationId) return;

    const initial = activeConversation.pendingPromptText ?? "";
    hydratedConversationIdRef.current = conversationId;
    lastPersistedPendingPromptRef.current =
      activeConversation.pendingPromptText;
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
      if (hydratedConversationIdRef.current !== conversationId) {
        hydratedConversationIdRef.current = conversationId;
      }
      setPromptText(next);
    },
    [conversationId, setPromptText],
  );

  // --- Flush pending debounced save on conversation switch / unmount ---
  // The cleanup function captures the previous conversationId, so when the
  // user navigates away or switches conversations before the 500ms debounce
  // timer fires, the in-flight draft is still POSTed to the server and will
  // be restored on next mount.
  useEffect(() => {
    const capturedConversationId = conversationId;
    return () => {
      flushPendingPromptText(capturedConversationId);
    };
  }, [conversationId, flushPendingPromptText]);

  // --- Flush pending debounced save on full page reload via sendBeacon ---
  // The regular fetch from useMutation may be aborted when the page unloads,
  // so we use navigator.sendBeacon (which is delivery-guaranteed on unload)
  // to flush any pending draft. The URL and payload format are shared with
  // the mutation hook via `sendPendingPromptBeacon`.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleBeforeUnload = () => {
      if (pendingPromptSaveTimerRef.current === null) return;
      const current = promptTextRef.current;
      const normalized = current === "" ? null : current;
      if (normalized === lastPersistedPendingPromptRef.current) return;
      const queued = sendPendingPromptBeacon(
        projectName,
        sessionName,
        conversationId,
        normalized,
      );
      if (queued) {
        lastPersistedPendingPromptRef.current = normalized;
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [projectName, sessionName, conversationId, promptTextRef]);

  // --- Debounced save of typed prompt text ---
  useEffect(() => {
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
