import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { conversationKeys, sessionKeys } from "@/lib/query-keys";
import {
  useSubmitPrompt,
  useReceiveStreamContent,
  useCompletePrompt,
  useFailPrompt,
  useShowQuestions,
} from "@/stores/session-detail.store";
import { tracedFetch } from "@/lib/traced-fetch";
import type {
  ClaudeModel,
  ImagePayload,
  MessageContentBlock,
  AskQuestionItem,
} from "@/types";

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
    modelId?: ClaudeModel,
    images?: ImagePayload[],
  ) => Promise<void>;
  /** Abort the in-flight SSE stream (client-side only). */
  abortClient: () => void;
}

export function useSendPrompt(
  projectName: string,
  sessionName: string,
  conversationId?: string,
): SendPromptHandle {
  const queryClient = useQueryClient();
  const submitPrompt = useSubmitPrompt();
  const receiveStreamContent = useReceiveStreamContent();
  const completePrompt = useCompletePrompt();
  const failPrompt = useFailPrompt();
  const showQuestions = useShowQuestions();

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
      modelId?: ClaudeModel,
      images?: ImagePayload[],
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
      // display formatted commands (matches transcript.ts parseCommandContent)
      const displayContent: MessageContentBlock[] =
        userContent.length === 1 && userContent[0]?.type === "text"
          ? (() => {
              const text = (userContent[0] as { type: "text"; text: string })
                .text;
              // XML-tagged commands (from prompt templates like focus mode)
              const nameMatch = text.match(
                /<command-name>\/?(.+?)<\/command-name>/,
              );
              if (nameMatch) {
                const argsMatch = text.match(
                  /<command-args>([\s\S]*?)<\/command-args>/,
                );
                return [
                  {
                    type: "command" as const,
                    name: `/${nameMatch[1]!}`,
                    args: argsMatch?.[1]?.trim() || null,
                  },
                ];
              }
              // Plain text slash commands (e.g., "/commit", "/kiro:spec-init feature")
              const plainMatch = text
                .trim()
                .match(/^\/([a-zA-Z][\w:-]*)(?:\s+([\s\S]*))?$/);
              if (plainMatch) {
                return [
                  {
                    type: "command" as const,
                    name: `/${plainMatch[1]!}`,
                    args: plainMatch[2]?.trim() || null,
                  },
                ];
              }
              return userContent;
            })()
          : userContent;

      // 1. Set optimistic state via Zustand
      submitPrompt(displayContent, currentMessageCount);

      // 2. Build prompt URL
      const promptUrl = conversationId
        ? `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/conversations/${encodeURIComponent(conversationId)}/prompt`
        : `/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionName)}/prompt`;

      try {
        const res = await tracedFetch(promptUrl, "send-prompt", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt: trimmed,
            modelId,
            images: hasImages ? images : undefined,
          }),
          signal: controller.signal,
        });

        // 3. Handle non-streaming errors
        if (!res.ok) {
          const data = await res
            .json()
            .catch(() => ({ error: "Prompt failed" }));
          failPrompt((data as { error?: string }).error ?? "Prompt failed");
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
                receiveStreamContent(displayContent, [...streamBlocks]);
              } catch {
                // Skip malformed content events
              }
            } else if (eventName === "ask-question") {
              try {
                const data = JSON.parse(eventData) as {
                  questionId: string;
                  questions: AskQuestionItem[];
                };
                showQuestions(data.questionId, data.questions);
              } catch {
                // Skip malformed question events
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
            } else if (eventName === "aborted") {
              break;
            } else if (eventName === "done") {
              break;
            }
          }
        }
      } catch (e) {
        // Abort is expected during navigation — don't treat as error
        if (e instanceof DOMException && e.name === "AbortError") return;
        failPrompt("Failed to send prompt");
      } finally {
        // Skip completion/invalidation for aborted requests
        if (controller.signal.aborted) return;

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
      showQuestions,
    ],
  );

  return { send, abortClient };
}
