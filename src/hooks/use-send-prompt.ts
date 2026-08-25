import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { conversationKeys } from "@/lib/conversations/query-keys";
import { gitKeys } from "@/lib/git/query-keys";
import { parseCommandContent } from "@/lib/commands/parsing";
import {
  useSubmitPrompt,
  useReceiveStreamContent,
  useCompletePrompt,
  useFailPrompt,
  useShowQuestions,
  useAddOptimisticQueueEntry,
  useAcceptOptimisticQueueEntry,
  useRollbackOptimisticQueueEntry,
  useSetQueueError,
} from "@/stores/session-detail.store";
import { tracedFetch } from "@/lib/shared/traced-fetch";
import { consumePromptStream } from "@/lib/prompt/stream-transport";
import { backendSupportsFastMode } from "@/lib/agent-backends/catalog";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { MessageContentBlock } from "@/lib/conversations/schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { QueueEnqueueResponse } from "@/lib/prompt/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { appendCursorContentDelta } from "@/lib/agent-backends/cursor/content-deltas";
import { CURSOR_BACKEND_ID } from "@/lib/agent-backends/cursor/backend-id";
/**
 * Hook that coordinates prompt submission with:
 * - Zustand store (optimistic UI state)
 * - Fetch API (SSE streaming)
 * - TanStack Query (cache invalidation on completion)
 */
export interface SendPromptHandle {
  send: (
    text: string,
    currentMessageCount: number,
    modelId?: string,
    images?: ImagePayload[],
    effort?: EffortLevel,
    backend?: AgentBackendId,
    submittedPendingPromptText?: string,
    codexFastMode?: boolean,
  ) => Promise<void>;
  /** Queue a message into a running conversation. */
  queue: (
    text: string,
    images?: ImagePayload[],
    submittedPendingPromptText?: string,
  ) => Promise<void>;
  /** Abort the in-flight SSE stream (client-side only). */
  abortClient: () => void;
}

export function useSendPrompt(
  projectName: string,
  sessionName: string,
  conversationId: string,
): SendPromptHandle {
  const queryClient = useQueryClient();
  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();
  const failPrompt = useFailPrompt();
  const showQuestions = useShowQuestions();
  const addOptimisticQueueEntry = useAddOptimisticQueueEntry();
  const acceptOptimisticQueueEntry = useAcceptOptimisticQueueEntry();
  const rollbackOptimisticQueueEntry = useRollbackOptimisticQueueEntry();
  const setQueueError = useSetQueueError();

  // Abort in-flight streams when session context changes or on unmount
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [projectName, sessionName, conversationId]);

  const abortClient = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(
    async (
      text: string,
      currentMessageCount: number,
      modelId?: string,
      images?: ImagePayload[],
      effort?: EffortLevel,
      backend?: AgentBackendId,
      submittedPendingPromptText?: string,
      codexFastMode?: boolean,
    ) => {
      const trimmed = text.trim();
      const hasImages = images && images.length > 0;
      if (!trimmed && !hasImages) return;

      // Abort any previous in-flight stream
      abortRef.current?.abort();

      // Create new AbortController for this request
      const controller = new AbortController();
      abortRef.current = controller;

      // Build user content blocks for optimistic messages
      const userContent: MessageContentBlock[] = [
        ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
        ...(images ?? []).map((img) => ({
          type: "image" as const,
          mediaType: img.mediaType,
          base64Data: img.base64Data,
        })),
      ];

      // Parse command tags or plain slash commands so optimistic messages
      // display formatted commands (uses shared parseCommandContent)
      const displayContent: MessageContentBlock[] =
        userContent.length === 1 && userContent[0]?.type === "text"
          ? (() => {
              const text = (userContent[0] as { type: "text"; text: string })
                .text;
              const parsed = parseCommandContent(text);
              return parsed ? [parsed] : userContent;
            })()
          : userContent;

      // 1. Set optimistic state via Zustand
      const agentSettings = {
        ...(modelId !== undefined ? { model: modelId } : {}),
        ...(effort !== undefined ? { effort } : {}),
        ...(backend !== undefined &&
        backendSupportsFastMode(backend) &&
        codexFastMode !== undefined
          ? { codexFastMode }
          : {}),
      };
      submitPrompt(
        conversationId,
        displayContent,
        currentMessageCount,
        agentSettings,
      );

      // 2. Build prompt URL
      const promptUrl = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/prompt`;

      // Phase 1: dispatch the POST. Transport-level failures and non-OK
      // responses surface to callers via a rejected promise so atomic-flow
      // callers (e.g. DebugActionCard Strategy B) can roll back state they
      // advanced before invoking send.
      let res: Response;
      try {
        res = await tracedFetch(promptUrl, "send-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: trimmed,
            submittedPendingPromptText,
            modelId,
            effort,
            images: hasImages ? images : undefined,
            backend,
            ...(backend !== undefined &&
            backendSupportsFastMode(backend) &&
            codexFastMode !== undefined
              ? { codexFastMode }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") {
          // Keyed in-flight state survives workspace swaps, so an aborted
          // request must clear its own sending flag — nothing else resets it.
          completePrompt(conversationId);
          return;
        }
        failPrompt(conversationId, "Failed to send prompt");
        completePrompt(conversationId);
        throw e instanceof Error ? e : new Error("Failed to send prompt");
      }

      if (!res.ok) {
        const data = (await res
          .json()
          .catch(() => ({ error: "Prompt failed" }))) as {
          error?: string;
        };
        const message = data.error ?? "Prompt failed";
        failPrompt(conversationId, message);
        completePrompt(conversationId);
        throw new Error(message);
      }

      try {
        // 4. Read SSE stream
        if (!res.body) {
          failPrompt(conversationId, "No response stream");
          return;
        }

        const streamBlocks: MessageContentBlock[] = [];
        await consumePromptStream(res.body, (event) => {
          switch (event.type) {
            case "content":
              if (backend === CURSOR_BACKEND_ID) {
                appendCursorContentDelta(streamBlocks, event.block);
              } else {
                streamBlocks.push(event.block);
              }
              receiveStreamContent(
                conversationId,
                displayContent,
                [...streamBlocks],
                agentSettings,
              );
              break;
            case "ask-question":
              showQuestions(event.questionId, event.questions);
              break;
            case "error":
              failPrompt(conversationId, event.message ?? "Prompt failed");
              break;
            case "aborted":
            case "done":
              break;
          }
        });
      } catch (e) {
        // Abort is expected during navigation — don't treat as error
        if (e instanceof DOMException && e.name === "AbortError") return;
        failPrompt(conversationId, "Failed to send prompt");
      } finally {
        // Always clear this conversation's sending flag — in-flight state is
        // keyed per conversation and survives workspace swaps, so an aborted
        // client stream must not strand a stale "sending" on the conversation
        // (the server turn, if still running, keeps the indicator alive via
        // status === "running"). Only the cache invalidations are skipped for
        // aborted requests.
        completePrompt(conversationId);
        if (controller.signal.aborted) return;

        // 5. Invalidate TanStack Query caches
        void queryClient.invalidateQueries({
          queryKey: conversationKeys.messages(
            projectName,
            sessionName,
            conversationId,
          ),
        });
        void queryClient.invalidateQueries({
          queryKey: gitKeys.diff(projectName, sessionName),
        });
        void queryClient.invalidateQueries({
          queryKey: gitKeys.commits(projectName, sessionName),
        });
      }
    },
    [
      projectName,
      sessionName,
      conversationId,
      queryClient,
      submitPrompt,
      receiveStreamContent,
      completePrompt,
      failPrompt,
      showQuestions,
    ],
  );

  const queue = useCallback(
    async (
      text: string,
      images?: ImagePayload[],
      submittedPendingPromptText?: string,
    ) => {
      // No gate on the tab-local `sending` flag here: a running turn is not
      // always one this tab started (drained next-turn delivery, reload,
      // another client). The caller owns the queue-vs-send routing.
      const trimmed = text.trim();
      const hasImages = images !== undefined && images.length > 0;
      if (!trimmed && !hasImages) return;

      // Build the same user content blocks the normal send path builds so the
      // pending entry renders identically once queued.
      const content: MessageContentBlock[] = [
        ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
        ...(images ?? []).map((img) => ({
          type: "image" as const,
          mediaType: img.mediaType,
          base64Data: img.base64Data,
        })),
      ];

      // Optimistically add the pending entry. This never touches `sending`, so a
      // later failure leaves the running turn shown as running (req 5.2).
      const tempId = crypto.randomUUID();
      addOptimisticQueueEntry(conversationId, tempId, content);

      const queueUrl = `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/queue`;

      let res: Response;
      try {
        res = await tracedFetch(queueUrl, "queue-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmed || undefined,
            submittedPendingPromptText,
            images: hasImages ? images : undefined,
          }),
        });
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") return;
        // Roll back ONLY this failed entry (req 5.3) and surface the error
        // (req 5.1) without clearing `sending` (req 5.2).
        rollbackOptimisticQueueEntry(conversationId, tempId);
        setQueueError(conversationId, "Failed to queue message");
        return;
      }

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        rollbackOptimisticQueueEntry(conversationId, tempId);
        setQueueError(conversationId, data.error ?? "Failed to queue message");
        return;
      }

      const data = (await res
        .json()
        .catch(() => null)) as QueueEnqueueResponse | null;
      // Track the server-assigned queue id so cancellation and reconciliation
      // can target this entry. A malformed success body leaves the entry pending
      // optimistically rather than crashing.
      if (data && data.queued) {
        acceptOptimisticQueueEntry(conversationId, tempId, data.message.id);
      }
    },
    [
      projectName,
      sessionName,
      conversationId,
      addOptimisticQueueEntry,
      acceptOptimisticQueueEntry,
      rollbackOptimisticQueueEntry,
      setQueueError,
    ],
  );

  return { send, queue, abortClient };
}
