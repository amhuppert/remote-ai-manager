import { useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { conversationKeys, sessionKeys } from "@/lib/query-keys";
import {
  useSubmitPrompt,
  useReceiveStreamContent,
  useCompletePrompt,
  useFailPrompt,
} from "@/stores/session-detail.store";
import { tracedFetch } from "@/lib/traced-fetch";
import type { ClaudeModel, MessageContentBlock } from "@/types";

/**
 * Hook that coordinates prompt submission with:
 * - Zustand store (optimistic UI state)
 * - Fetch API (SSE streaming)
 * - TanStack Query (cache invalidation on completion)
 */
export function useSendPrompt(
  projectName: string,
  sessionName: string,
  conversationId?: string,
): (text: string, currentMessageCount: number, modelId?: ClaudeModel) => Promise<void> {
  const queryClient = useQueryClient();
  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();
  const failPrompt = useFailPrompt();

  return useCallback(
    async (text: string, currentMessageCount: number, modelId?: ClaudeModel) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      // 1. Set optimistic state via Zustand
      submitPrompt(trimmed, currentMessageCount);

      // 2. Build prompt URL
      const promptUrl = conversationId
        ? `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/prompt`
        : `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/prompt`;

      try {
        const res = await tracedFetch(promptUrl, "send-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: trimmed, modelId }),
        });

        // 3. Handle non-streaming errors
        if (!res.ok) {
          const data = await res
            .json()
            .catch(() => ({ error: "Prompt failed" }));
          failPrompt(
            (data as { error?: string }).error ?? "Prompt failed",
          );
          return;
        }

        // 4. Read SSE stream
        const reader = res.body?.getReader();
        if (!reader) {
          failPrompt("No response stream");
          return;
        }

        const decoder = new TextDecoder();
        const streamBlocks: MessageContentBlock[] = [];
        let buffer = "";

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Split on double newline for complete SSE events
          const parts = buffer.split("\n\n");
          // Keep the last part as it may be incomplete
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            if (!part.trim()) continue;

            // Parse SSE event: "event: <name>\ndata: <json>"
            let eventName = "";
            let eventData = "";
            for (const line of part.split("\n")) {
              if (line.startsWith("event: ")) {
                eventName = line.slice(7);
              } else if (line.startsWith("data: ")) {
                eventData = line.slice(6);
              }
            }

            if (!eventName || !eventData) continue;

            if (eventName === "content") {
              try {
                const block = JSON.parse(eventData) as MessageContentBlock;
                streamBlocks.push(block);
                receiveStreamContent(trimmed, [...streamBlocks]);
              } catch {
                // Skip malformed content events
              }
            } else if (eventName === "error") {
              try {
                const data = JSON.parse(eventData) as {
                  message?: string;
                };
                failPrompt(data.message ?? "Prompt failed");
              } catch {
                failPrompt("Prompt failed");
              }
            } else if (eventName === "done") {
              break;
            }
          }
        }
      } catch {
        failPrompt("Failed to send prompt");
      } finally {
        completePrompt();

        // 5. Invalidate TanStack Query caches
        if (conversationId) {
          void queryClient.invalidateQueries({
            queryKey: conversationKeys.messages(
              projectName,
              sessionName,
              conversationId,
            ),
          });
        }
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.diff(projectName, sessionName),
        });
        void queryClient.invalidateQueries({
          queryKey: sessionKeys.commits(projectName, sessionName),
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
    ],
  );
}
