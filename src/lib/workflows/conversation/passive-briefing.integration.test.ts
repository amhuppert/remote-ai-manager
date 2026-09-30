import { afterEach, describe, expect, it } from "vitest";
import type {
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import {
  createSubscriptionService,
  type SubscriptionService,
} from "@/lib/subscriptions/service";
import { followAcceptedNotepadContext } from "@/lib/subscriptions/involvement";

const result: ConversationBackendTurnResult = {
  backendRef: { backend: "claude", ref: "passive-test" },
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
  "passive turn integration (%s)",
  (scope) => {
    it.each(["mcp", "capabilities"] as const)(
      "records actual subscription acceptance when an unrelated %s receipt rejects",
      async (policy) => {
        let accepting = false;
        const backend = createMockBackendRuntime({
          sendTurn: async (input) => {
            accepting = true;
            await input.onEvent(
              policy === "mcp"
                ? { type: "input_accepted", mcpConfigHash: "accepted-hash" }
                : {
                    type: "input_accepted",
                    capabilities: { backend: "claude", kinds: [] },
                  },
            );
            return result;
          },
        });
        fixture = await createLifecycleFixture({
          address: {
            projectPath: "/passive-repo",
            target:
              scope === "project"
                ? { scope, projectName: "passive-repo", conversationId: "c" }
                : {
                    scope,
                    projectName: "passive-repo",
                    sessionName: "s",
                    conversationId: "c",
                  },
          },
          actorDeps: {
            getConversationBackendFactory: () => ({
              backend: "claude",
              createRuntime: async () => backend,
              validateModelSelection() {},
            }),
            async mutateConversation(...args) {
              if (
                accepting &&
                args[3] ===
                  (policy === "mcp"
                    ? "mcp.dispatchReceipt"
                    : "prompt.updateCapabilityRuntime")
              )
                throw new Error("Policy receipt unavailable");
              await fixture?.persistence.store.mutateConversation(...args);
            },
            subscriptions: {
              synchronizeInvolvement: async () => {},
              coveredNotepadIds: async () => [],
              async prepareBriefing(input) {
                return service.prepareBriefing(input);
              },
            },
          },
        });
        const repo = createConversationSubscriptionsRepo(
          fixture.persistence.db,
          createWriteQueue(),
        );
        const recipient = { projectPath: "/passive-repo", conversationId: "c" };
        const at = "2026-09-30T12:00:00Z";
        const service: SubscriptionService = createSubscriptionService({
          repo,
          isRecipientEligible: async () => true,
          readSource: async () => ({
            cursor: "2",
            missing: false,
            facts: [
              {
                occurrenceId: "revision-2",
                eventKind: "content-revised",
                category: "revision",
                sourceTitle: "Notes",
                summary: "Updated notes",
                occurredAt: at,
                revision: "2",
                outcome: null,
                retrievalHandle: "cctl notepad get notes",
                actorConversationId: null,
              },
            ],
          }),
          now: () => at,
        });
        await service.autoFollow({
          recipient,
          source: { kind: "notepad", id: "notes" },
          reason: "Supplied notes",
          initialCursor: "1",
        });
        const turn = await fixture.manager.submitConversationTurn({
          binding: fixture.binding,
          turn: { promptText: "Continue", inputOrigin: "user" },
        });
        if (turn.kind !== "accepted") throw new Error(turn.message);
        await turn.turn.completed;
        expect(
          (await repo.readInbox(recipient, { includeSettled: true })).items[0]
            ?.state,
        ).toBe("accepted");
      },
    );

    it("records accepted notepad involvement independently of failed watermark persistence", async () => {
      const backend = createMockBackendRuntime({
        sendTurn: async (input) => {
          expect(input.promptText).toContain("revision: 7");
          await input.onEvent({ type: "input_accepted" });
          return result;
        },
      });
      fixture = await createLifecycleFixture({
        address: {
          projectPath: "/passive-repo",
          target:
            scope === "project"
              ? { scope, projectName: "passive-repo", conversationId: "c" }
              : {
                  scope,
                  projectName: "passive-repo",
                  sessionName: "s",
                  conversationId: "c",
                },
        },
        actorDeps: {
          getConversationBackendFactory: () => ({
            backend: "claude",
            createRuntime: async () => backend,
            validateModelSelection() {},
          }),
          readNotepadForInjection: async () => ({
            id: "notes",
            name: "Notes",
            revision: 7,
            content: "Accepted notes",
            writeMode: "full-edit",
            openComments: { count: 0, latestCreatedAt: null },
          }),
          recordNotepadDeliveries: async () => {
            throw new Error("Notepad deleted before watermark persistence");
          },
          subscriptions: {
            synchronizeInvolvement: async () => {},
            coveredNotepadIds: async () => [],
            prepareBriefing: async () => ({
              block: null,
              onInputAccepted: async () => {},
              finish: async () => {},
            }),
            async recordAcceptedNotepadReferences(recipient, references) {
              await followAcceptedNotepadContext(
                recipient,
                references,
                service,
              );
            },
          },
        },
      });
      const repo = createConversationSubscriptionsRepo(
        fixture.persistence.db,
        createWriteQueue(),
      );
      const service: SubscriptionService = createSubscriptionService({
        repo,
        isRecipientEligible: async () => true,
        readSource: async () => ({ cursor: null, facts: [], missing: true }),
      });
      const turn = await fixture.manager.submitConversationTurn({
        binding: fixture.binding,
        turn: {
          promptText: '<notepad-ref notepad-id="notes" />',
          inputOrigin: "user",
        },
      });
      if (turn.kind !== "accepted") throw new Error(turn.message);
      await turn.turn.completed;
      expect(
        (
          await repo.list({ projectPath: "/passive-repo", conversationId: "c" })
        )[0],
      ).toMatchObject({
        cursor: "7",
        source: { kind: "notepad", id: "notes" },
      });
    });

    it("puts updates only into explicit user input and settles at acceptance", async () => {
      let pending = true;
      let preparations = 0;
      const prompts: ConversationBackendTurnInput[] = [];
      const backend = createMockBackendRuntime({
        sendTurn: async (input) => {
          prompts.push(input);
          if (input.promptText.includes("<passive-test>"))
            expect(pending).toBe(true);
          await input.onEvent({ type: "input_accepted" });
          return result;
        },
      });
      fixture = await createLifecycleFixture({
        address: {
          projectPath: "/passive-repo",
          target:
            scope === "project"
              ? { scope, projectName: "passive-repo", conversationId: "c" }
              : {
                  scope,
                  projectName: "passive-repo",
                  sessionName: "s",
                  conversationId: "c",
                },
        },
        actorDeps: {
          getConversationBackendFactory: () => ({
            backend: "claude",
            createRuntime: async () => backend,
            validateModelSelection() {},
          }),
          subscriptions: {
            synchronizeInvolvement: async () => {},
            coveredNotepadIds: async () => [],
            prepareBriefing: async () => {
              preparations++;
              return {
                block: pending
                  ? "<passive-test>Latest update</passive-test>"
                  : null,
                onInputAccepted: async () => {
                  pending = false;
                },
                finish: async () => {},
              };
            },
          },
        },
      });
      for (const inputOrigin of [undefined, "generated", "user"] as const) {
        const turn = await fixture.manager.submitConversationTurn({
          binding: fixture.binding,
          turn: {
            promptText: "Continue",
            autonomous: false,
            ...(inputOrigin ? { inputOrigin } : {}),
          },
        });
        if (turn.kind !== "accepted") throw new Error(turn.message);
        await turn.turn.completed;
        if (inputOrigin !== "user") expect(pending).toBe(true);
      }
      expect(preparations).toBe(1);
      expect(
        prompts.map(({ promptText }) => promptText.includes("<passive-test>")),
      ).toEqual([false, false, true]);
      expect(pending).toBe(false);
    });

    it("holds dispatched updates without acceptance as uncertain", async () => {
      let disposition: string | undefined;
      const backend = createMockBackendRuntime({
        sendTurn: async () => result,
      });
      fixture = await createLifecycleFixture({
        address: {
          projectPath: "/passive-repo",
          target:
            scope === "project"
              ? { scope, projectName: "passive-repo", conversationId: "c" }
              : {
                  scope,
                  projectName: "passive-repo",
                  sessionName: "s",
                  conversationId: "c",
                },
        },
        actorDeps: {
          getConversationBackendFactory: () => ({
            backend: "claude",
            createRuntime: async () => backend,
            validateModelSelection() {},
          }),
          subscriptions: {
            synchronizeInvolvement: async () => {},
            coveredNotepadIds: async () => [],
            prepareBriefing: async () => ({
              block: "Passive update",
              onInputAccepted: async () => {
                disposition = "accepted";
              },
              finish: async (options) => {
                disposition = options?.disposition;
              },
            }),
          },
        },
      });
      const turn = await fixture.manager.submitConversationTurn({
        binding: fixture.binding,
        turn: { promptText: "Continue", inputOrigin: "user" },
      });
      if (turn.kind !== "accepted") throw new Error(turn.message);
      await turn.turn.completed;
      expect(disposition).toBe("uncertain");
    });
  },
);
