import { afterEach, describe, expect, it } from "vitest";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionService } from "@/lib/subscriptions/service";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";

const result: ConversationBackendTurnResult = {
  backendRef: { backend: "claude", ref: "notice-inbox-test" },
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};

let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe.each(["session", "project"] as const)(
  "durable notice delivery to a warm %s conversation",
  (scope) => {
    it("holds feedback through generated turns and accepts it once with the next user message", async () => {
      const prompts: string[] = [];
      let runtimeCreations = 0;
      const backend = createMockBackendRuntime({
        async sendTurn(input) {
          prompts.push(input.promptText);
          if (input.promptText.includes("Review feedback marker 171")) {
            expect((await repo.readInbox(recipient, {})).items[0]?.state).toBe(
              "queued",
            );
          }
          await input.onEvent({ type: "input_accepted" });
          return result;
        },
      });
      fixture = await createLifecycleFixture({
        address: {
          projectPath: "/notice-inbox",
          target:
            scope === "project"
              ? { scope, projectName: "notice-inbox", conversationId: "c" }
              : {
                  scope,
                  projectName: "notice-inbox",
                  sessionName: "s",
                  conversationId: "c",
                },
        },
        actorDeps: {
          getConversationBackendFactory: () => ({
            backend: "claude",
            async createRuntime() {
              runtimeCreations++;
              return backend;
            },
            validateModelSelection() {},
          }),
          subscriptions: {
            prepareBriefing: (input) => service.prepareBriefing(input),
          },
        },
      });
      const { manager, binding } = fixture;
      const writeQueue = createWriteQueue();
      const repo = createConversationSubscriptionsRepo(
        fixture.persistence.db,
        writeQueue,
      );
      const recipient = { projectPath: "/notice-inbox", conversationId: "c" };
      const service = createSubscriptionService({
        repo,
        isRecipientEligible: async () => true,
        readSource: async () => ({ cursor: "101", missing: false, facts: [] }),
      });
      async function submit(inputOrigin: "user" | "generated") {
        const admission = await manager.submitConversationTurn({
          binding,
          turn: { promptText: "Continue", inputOrigin },
        });
        if (admission.kind !== "accepted") throw new Error(admission.message);
        await admission.turn.completed;
      }

      await submit("user");
      expect(runtimeCreations).toBe(1);
      const notice = {
        recipient,
        source: { kind: "spec" as const, id: "spec-171" },
        reason: "Feedback for the authoring conversation",
        fact: {
          occurrenceId: "101",
          eventKind: "spec-review-commented",
          category: "decision" as const,
          sourceTitle: "Review fixture",
          summary: "Review feedback marker 171",
          occurredAt: "2026-10-01T00:00:00.000Z",
          revision: "revision-1",
          outcome: "commented",
          retrievalHandle: "cctl spec comments --open -- review-fixture",
          actorConversationId: null,
        },
      };
      expect(await service.recordNotice(notice)).toBe(true);
      expect(await service.recordNotice(notice)).toBe(false);
      await submit("generated");
      expect((await repo.readInbox(recipient, {})).items[0]?.state).toBe(
        "pending",
      );
      await submit("user");
      await submit("user");

      expect(runtimeCreations).toBe(1);
      expect(
        prompts.map((text) => text.includes("Review feedback marker 171")),
      ).toEqual([false, false, true, false]);
      const reloaded = createConversationSubscriptionsRepo(
        fixture.persistence.db,
        writeQueue,
      );
      const evidence = await reloaded.readInbox(recipient, {
        includeSettled: true,
      });
      expect(evidence.items).toHaveLength(1);
      expect(evidence.items[0]).toMatchObject({
        state: "accepted",
        attemptCount: 1,
        fact: { occurrenceId: "101" },
      });
      expect(evidence.items[0]?.acceptedAt).toEqual(expect.any(String));
      expect((await reloaded.readInbox(recipient, {})).total).toBe(0);
    });
  },
);
