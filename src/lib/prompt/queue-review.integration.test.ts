import { describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import {
  storeSessionNameFromScopeRef,
  type ConversationScopeRef,
} from "@/lib/conversations/conversation-target";
import { createQueueRouteHandlers } from "./queue-route-handlers";
import { createProjectQueueRouteHandlers } from "@/lib/project-conversations/queue-route-handlers";
import { toQueuedMessageView } from "@/lib/conversations/message-queue-service";
import type { QueueOperationDeps } from "./queue-operations";

const scopes: ConversationScopeRef[] = [
  { scope: "session", sessionName: "s" },
  { scope: "project" },
];
describe.each(scopes)("queue review in $scope", (scope) => {
  it.each(["retry", "discard"] as const)(
    "%s durably resolves uncertainty before draining",
    async (action) => {
      const fixture = createPersistenceFixture();
      try {
        const key = {
          projectPath: "/review",
          sessionName: storeSessionNameFromScopeRef(scope),
          conversationId: "c",
        };
        fixture.seedProject(key.projectPath);
        if (scope.scope === "session")
          fixture.seedSession(key.projectPath, key.sessionName);
        const conversation = makeConversationState({
          id: key.conversationId,
          status: "awaiting",
          agentBackend: "cursor",
        });
        if (scope.scope === "project")
          await fixture.seedProjectConversation(key.projectPath, conversation);
        else
          await fixture.seedConversation(
            key.projectPath,
            key.sessionName,
            conversation,
          );
        const queue = createMessageQueueService({
          ...fixture.deps,
          getProjectDisplayName: () => "review",
          broadcast: () => {},
          now: () => new Date().toISOString(),
          newId: () => crypto.randomUUID(),
        });
        const entry = await queue.enqueue({
          ...key,
          content: [{ type: "text", text: "retained" }],
        });
        await queue.claimNextTurnBatch(key);
        await queue.recoverAbandonedDeliveries(key);
        let drainStatus: string[] | undefined;
        const deps: QueueOperationDeps = {
          admitModelSelection: async ({ modelSelection }) => ({
            ok: true,
            modelSelection,
          }),
          getProjectDisplayName: () => "review",
          queueMessage: async () => {
            throw new Error("review must not enqueue another payload");
          },
          queueCapabilityForBackend: () => ({
            acceptsWhileRunning: true,
            deliveryTiming: "next_turn",
          }),
          toQueuedMessageView,
          clearConversationPendingPromptTextIfMatches: async () => false,
          cancel: queue.cancel,
          resolveDelivery: queue.resolveDelivery,
          ensureConversationActorAndDrain: async () => {
            drainStatus = (await queue.listActive(key)).map(
              (row) => row.status,
            );
          },
        };
        const handlers =
          scope.scope === "project"
            ? createProjectQueueRouteHandlers({
                ...deps,
                resolveProjectPath: async () => key.projectPath,
                getProjectConversation: (path, id) =>
                  fixture.store.getConversation(path, key.sessionName, id),
              })
            : createQueueRouteHandlers({
                ...deps,
                resolveProjectPath: async () => key.projectPath,
                getSession: fixture.store.getSession,
                getConversation: fixture.store.getConversation,
              });
        const response = await handlers.REVIEW(
          new Request("http://test/queue", {
            method: "POST",
            body: JSON.stringify({ action }),
          }),
          {
            params: Promise.resolve({
              name: "review",
              session: key.sessionName,
              conversationId: key.conversationId,
              messageId: entry.id,
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          resolved: true,
          id: entry.id,
          action,
        });
        expect(drainStatus).toEqual(action === "retry" ? ["pending"] : []);
        const reloaded = await fixture
          .recreateStore()
          .getConversation(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          );
        expect(reloaded?.pendingQueue.map((row) => row.status)).toEqual(
          drainStatus,
        );
      } finally {
        fixture.close();
      }
    },
  );
});
