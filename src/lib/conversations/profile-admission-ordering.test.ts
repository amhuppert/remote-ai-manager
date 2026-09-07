/** Profile admission must commit before either direct or queued execution. */
import { expect, it, vi } from "vitest";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";

import { drainConversationQueue } from "./message-queue-drain";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(["direct", "queued"] as const)(
  "awaits profile admission before %s prompt execution",
  async (path) => {
    const gate = deferred();
    let admitting = false;
    const prompts: string[] = [];
    const fixture = await createLifecycleFixture({
      beforeProfileAdmission: () => {
        admitting = true;
        return gate.promise;
      },
      actorDeps: {
        executeAgentCall: async (request) => {
          prompts.push(request.prompt);
          return {
            backend: "claude",
            backendRef: null,
            capabilities: capabilityViewForBackend("claude"),
            usage: {},
            artifacts: [],
            outcome: { kind: "completed", text: "done" },
            continuationDisposition: "retain",
          };
        },
      },
    });
    try {
      await fixture.manager.ensureConversationLifecycle(fixture.binding);
      const actor = fixture.actor(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      )!;
      if (path === "queued")
        await fixture.queue.enqueue({
          ...fixture.identity,
          content: [{ type: "text", text: "queued hello" }],
        });
      const pending =
        path === "direct"
          ? fixture.manager.submitConversationTurn({
              binding: fixture.binding,
              turn: { promptText: "direct hello" },
            })
          : drainConversationQueue(
              {
                projectPath: fixture.identity.projectPath,
                target: fixture.binding.address.target,
              },
              {
                ...fixture.queue,
                submitTurn: fixture.manager.submitConversationTurn,
                runConversationCommand: async () => {
                  throw new Error("No command expected");
                },
              },
            );
      await vi.waitFor(() => expect(admitting).toBe(true));
      expect(actor.getSnapshot().context.activeTurn).toBeNull();
      expect(prompts).toEqual([]);
      gate.release();
      await pending;
      await vi.waitFor(() => expect(prompts).toHaveLength(1));
      expect(prompts[0]).toContain(`${path} hello`);
    } finally {
      gate.release();
      await fixture.close();
    }
  },
);
