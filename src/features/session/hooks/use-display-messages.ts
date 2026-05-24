"use client";

import { useEffect, useMemo } from "react";
import {
  useMessageCountBeforeSubmit,
  useOptimisticMessages,
  useReconcileMessages,
  useSending,
} from "@/stores/session-detail.store";
import type { TranscriptMessage } from "@/lib/conversations/schemas";
/**
 * Merge server transcript with in-flight optimistic messages for display, and
 * reconcile once the stream is done and the server transcript has caught up.
 *
 * During streaming the server transcript is written in real-time and polled
 * every 3s, so `messages` may already contain the assistant response that is
 * also in `optimisticMessages`. To avoid duplicates we slice server messages
 * to before the submit point and append optimistic instead.
 */
export function useDisplayMessages(
  messages: readonly TranscriptMessage[],
): readonly TranscriptMessage[] {
  const optimisticMessages = useOptimisticMessages();
  const messageCountBeforeSubmit = useMessageCountBeforeSubmit();
  const sending = useSending();
  const reconcileMessages = useReconcileMessages();

  useEffect(() => {
    if (optimisticMessages.length === 0) return;
    if (!sending && messages.length > messageCountBeforeSubmit) {
      reconcileMessages(messages.length);
    }
  }, [
    messages.length,
    optimisticMessages.length,
    messageCountBeforeSubmit,
    sending,
    reconcileMessages,
  ]);

  return useMemo(() => {
    if (optimisticMessages.length === 0) return messages;
    return [
      ...messages.slice(0, messageCountBeforeSubmit),
      ...optimisticMessages,
    ];
  }, [messages, optimisticMessages, messageCountBeforeSubmit]);
}
