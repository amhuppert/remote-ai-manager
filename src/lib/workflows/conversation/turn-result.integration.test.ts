import { expect, it } from "vitest";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";

it("accounts a normalized dispatch failure's partial spend even without content blocks", async () => {
  const fixture = await createLifecycleFixture({
    actorDeps: {
      executeAgentCall: async () => ({
        backend: "claude",
        backendRef: null,
        capabilities: capabilityViewForBackend("claude"),
        usage: { costUsd: 0.7, durationMs: 42 },
        artifacts: [],
        outcome: {
          kind: "failed",
          error: {
            backend: "claude",
            failureKind: "session_died",
            message: "Channel ended",
            retryable: true,
          },
        },
      }),
    },
  });
  try {
    const execution = await fixture.manager.executeConversationTurn({
      binding: fixture.binding,
      turn: { kind: "conversation_turn", promptText: "Inspect" },
    });
    expect(execution).toMatchObject({
      kind: "settled",
      turn: {
        outcome: { kind: "call_result", result: { usage: { costUsd: 0.7 } } },
      },
    });
    const row = await fixture.persistence.store.getConversation(
      fixture.identity.projectPath,
      fixture.identity.sessionName,
      fixture.identity.conversationId,
    );
    expect(row).toMatchObject({ totalCostUsd: 0.7, totalDurationMs: 42 });
  } finally {
    await fixture.close();
  }
});
