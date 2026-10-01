import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { SseEventTarget } from "@/lib/api/sse";
import { conversationKeys } from "./query-keys";
import { projectConversationKeys } from "@/lib/project-conversations-client/query-keys";
import { registerConversationSseReactions } from "./sse-reactions";
import { messageAppendedEventSchema, type TranscriptMessage } from "./schemas";

type StampedMessage = TranscriptMessage & { seq: number };
const origin = {
  source: "subscription_update",
  subscriptionUpdate: { batchId: "batch" },
} as const;
function message(seq: number, machine = false): StampedMessage {
  return {
    role: "user",
    timestamp: null,
    seq,
    content: [
      { type: "text", text: machine ? "Machine payload" : "Ordinary input" },
    ],
    ...(machine ? { origin } : {}),
  };
}

function harness(scope: "session" | "project", initial: StampedMessage[]) {
  const queryClient = new QueryClient();
  const key =
    scope === "project"
      ? projectConversationKeys.messages("demo", "conversation")
      : conversationKeys.messages("demo", "session", "conversation");
  queryClient.setQueryData(key, initial);
  const listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  const target: SseEventTarget = {
    addEventListener(type, listener) {
      listeners.set(type, [...(listeners.get(type) ?? []), listener]);
    },
  };
  registerConversationSseReactions(target, {
    queryClient,
    enqueueInputToast: vi.fn(),
    enqueuePromptErrorToast: vi.fn(),
    showBrowserNotification: vi.fn(),
    settleOptimisticQueueEntry: vi.fn(),
  });
  return {
    append(entry: StampedMessage) {
      const payload = messageAppendedEventSchema.parse({
        type: "message-appended",
        ...(scope === "session"
          ? { scope, sessionName: "session" }
          : { scope }),
        projectName: "demo",
        conversationId: "conversation",
        seq: entry.seq,
        message: entry,
      });
      const frame = new MessageEvent(payload.type, {
        data: JSON.stringify(payload),
      });
      for (const listener of listeners.get(payload.type) ?? []) listener(frame);
    },
    messages: () => queryClient.getQueryData<StampedMessage[]>(key),
  };
}

describe.each(["session", "project"] as const)(
  "subscription message SSE (%s)",
  (scope) => {
    it.each([false, true])(
      "retains separate provenance when the first merged input is machine=%s",
      (machineFirst) => {
        const first = message(0, machineFirst);
        const second = message(1, !machineFirst);
        const h = harness(scope, [first]);
        h.append(second);
        expect(h.messages()).toHaveLength(1);
        expect(h.messages()?.[0]?.content).toEqual([
          ...first.content,
          ...second.content,
        ]);
        expect(h.messages()?.[0]?.origin).toBeUndefined();
        expect(h.messages()?.[0]?.sourceParts).toEqual([
          {
            seq: 0,
            ...(machineFirst ? { origin } : {}),
            contentRange: { start: 0, end: 1 },
          },
          {
            seq: 1,
            ...(!machineFirst ? { origin } : {}),
            contentRange: { start: 1, end: 2 },
          },
        ]);
      },
    );

    it("keeps normalized part ranges when another ordinary input arrives", () => {
      const initial: StampedMessage = {
        ...message(1),
        content: [...message(0, true).content, ...message(1).content],
        sourceParts: [
          { seq: 0, origin, contentRange: { start: 0, end: 1 } },
          { seq: 1, contentRange: { start: 1, end: 2 } },
        ],
      };
      const h = harness(scope, [initial]);
      h.append(message(2));
      expect(h.messages()?.[0]?.sourceParts).toEqual([
        ...(initial.sourceParts ?? []),
        { seq: 2, contentRange: { start: 2, end: 3 } },
      ]);
    });
  },
);
