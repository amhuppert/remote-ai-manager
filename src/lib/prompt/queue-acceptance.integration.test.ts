import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { queueMessage } from "./queue";
import { createCoreLiveQueueHarness } from "./testing/core-live-queue-fixture";
import { createConversationSubscriptionsRepo } from "@/lib/state-store/conversation-subscriptions-repo";
import { createWriteQueue } from "@/lib/state-store/write-queue";
import { createSubscriptionService } from "@/lib/subscriptions/service";
import { followAcceptedNotepadContext } from "@/lib/subscriptions/involvement";

describe.each(["session", "project"] as const)(
  "live acceptance durability (%s)",
  (scope) => {
    let fixture: ReturnType<typeof createPersistenceFixture>;
    const key = {
      projectPath: "/repo",
      sessionName:
        scope === "project" ? PROJECT_CONVERSATION_SESSION_SENTINEL : "session",
      conversationId: `acceptance-${scope}`,
    };

    beforeEach(async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(key.projectPath);
      const conversation = makeConversationState({
        id: key.conversationId,
        status: "awaiting",
        agentBackend: "claude",
        scope,
      });
      if (scope === "project") {
        await fixture.seedProjectConversation(key.projectPath, conversation);
      } else {
        fixture.seedSession(key.projectPath, key.sessionName);
        await fixture.seedConversation(
          key.projectPath,
          key.sessionName,
          conversation,
        );
      }
    });
    afterEach(async () => {
      for (const turn of activeTurns.splice(0)) {
        turn.harness.endTurn();
        await turn.ended;
      }
      fixture.close();
    });

    const activeTurns: Array<{
      harness: ReturnType<typeof createCoreLiveQueueHarness>;
      ended: Promise<unknown>;
    }> = [];
    async function harness() {
      const h = createCoreLiveQueueHarness(fixture, key);
      const turn = await h.startTurn();
      activeTurns.push({ harness: h, ended: turn.ended });
      return { ...h, ended: turn.ended };
    }

    it("archives once before releasing the accepted response", async () => {
      const h = await harness();
      h.runtime.queueUserInput = async (input) => {
        await input.onAccepted?.();
        await input.onAccepted?.();
        expect(h.archive).toHaveLength(1);
        h.outputs.push("response");
      };
      await h.send();
      expect(h.archive[0]?.id).toBe("message-1");
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("delivers a subscription update during the current turn with its durable receipt and provenance", async () => {
      const h = await harness();
      let passiveBriefings = 0;
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          passiveBriefings++;
          return {
            block: null,
            onInputAccepted: async () => {},
            finish: async () => {},
          };
        },
      };
      const delivered = await h.send("Reviewer finished", {
        inputOrigin: "generated",
        metadata: { kind: "subscription_update", batchId: "review-complete" },
      });
      expect(delivered.deliveryTiming).toBe("in_turn");
      expect(h.sent).toEqual(["Reviewer finished"]);
      expect(h.archive).toEqual([
        expect.objectContaining({
          id: "review-complete",
          origin: {
            source: "subscription_update",
            subscriptionUpdate: { batchId: "review-complete" },
          },
        }),
      ]);
      expect(passiveBriefings).toBe(0);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("attaches a passive briefing to live user input without recording it as user text", async () => {
      const h = await harness();
      let state = "pending";
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          state = "queued";
          return {
            block: "<passive-briefing>Latest update</passive-briefing>",
            onInputAccepted: async () => {
              state = "accepted";
            },
            finish: async () => {},
          };
        },
      };
      h.runtime.queueUserInput = async (input) => {
        expect(state).toBe("queued");
        expect(input.content[0]).toEqual({
          type: "text",
          text: expect.stringContaining(
            "<passive-briefing>Latest update</passive-briefing>",
          ),
        });
        await input.onAccepted?.();
      };
      await h.send();
      expect(state).toBe("accepted");
      expect(h.archive[0]?.content).toEqual([{ type: "text", text: "hello" }]);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("leaves passive updates pending for generated ordinary text and question-answer input", async () => {
      const h = await harness();
      let preparations = 0;
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          preparations++;
          return {
            block: "Update",
            onInputAccepted: async () => {},
            finish: async () => {},
          };
        },
      };
      await queueMessage({
        ...key,
        backend: "claude",
        text: "Generated alignment feedback",
        inputOrigin: "generated",
        deps: h.deps,
      });
      await queueMessage({
        ...key,
        backend: "claude",
        text: "Protocol answers",
        inputOrigin: "user",
        metadata: { kind: "question_answers", questionBatchId: "q" },
        deps: h.deps,
      });
      await queueMessage({
        ...key,
        backend: "claude",
        inputOrigin: "user",
        documentFeedback: { items: [] },
        deps: h.deps,
      });
      expect(preparations).toBe(0);
    });

    it("records live accepted notepad involvement even when the watermark write fails", async () => {
      const h = await harness();
      const repo = createConversationSubscriptionsRepo(
        fixture.db,
        createWriteQueue(),
      );
      const service = createSubscriptionService({
        repo,
        isRecipientEligible: async () => true,
        readSource: async () => ({ cursor: null, facts: [], missing: true }),
      });
      h.inputDeps.context.readNotepadForInjection = async () => ({
        id: "notes",
        name: "Notes",
        revision: 7,
        content: "Accepted notes",
        writeMode: "full-edit",
        openComments: { count: 0, latestCreatedAt: null },
      });
      h.inputDeps.effects.recordNotepadDeliveries = async () => {
        throw new Error("Source deleted before watermark persistence");
      };
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => ({
          block: null,
          onInputAccepted: async () => {},
          finish: async () => {},
        }),
        recordAcceptedNotepadReferences: (recipient, references) =>
          followAcceptedNotepadContext(recipient, references, service),
      };
      await h.send('<notepad-ref notepad-id="notes" />');
      expect(
        (
          await repo.list({
            projectPath: key.projectPath,
            conversationId: key.conversationId,
          })
        )[0],
      ).toMatchObject({
        cursor: JSON.stringify({
          revision: 7,
          legacyOpenComments: { count: 0, latestCreatedAt: null },
        }),
        source: { kind: "notepad", id: "notes" },
      });
      expect((await h.reload())?.pendingQueue).toEqual([]);
      expect(h.archive).toHaveLength(1);
      expect(h.archive[0]).toMatchObject({
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: '<notepad-ref notepad-id="notes" />' }],
      });
    });

    it("holds unconfirmed live briefing delivery as uncertain", async () => {
      const h = await harness();
      let disposition: string | undefined;
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => ({
          block: "Update",
          onInputAccepted: async () => {},
          finish: async (options) => {
            disposition = options?.disposition;
          },
        }),
      };
      h.runtime.queueUserInput = async () => {};
      await h.send();
      expect(disposition).toBe("uncertain");
    });

    it("retains an accepted live briefing receipt for repair without redispatch", async () => {
      const h = await harness();
      let fail = true;
      let accepted = false;
      let recorded = false;
      let dispatches = 0;
      const record = async () => {
        if (fail) throw new Error("receipt unavailable");
        recorded = true;
      };
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => ({
          block: "Update",
          onInputAccepted: async () => {
            accepted = true;
            await record();
          },
          finish: async () => {
            if (accepted) await record();
          },
        }),
      };
      h.runtime.queueUserInput = async (input) => {
        dispatches++;
        await input.onAccepted?.();
      };
      const sent = await h.send();
      expect(sent.deliveryTiming).toBe("in_turn");
      expect((await h.reload())?.pendingQueue).toEqual([]);
      expect(recorded).toBe(false);
      fail = false;
      await h.turns.settleRetained(key.conversationId);
      expect(recorded).toBe(true);
      expect(dispatches).toBe(1);
    });

    it("preserves explicit user provenance through a durable queued-message reload", async () => {
      const h = await harness();
      const queued = await h.service.enqueue({
        ...key,
        inputOrigin: "user",
        content: [{ type: "text", text: "Queued user request" }],
      });
      expect((await h.reload())?.pendingQueue[0]?.inputOrigin).toBe("user");
      const claimed = await h.service.claimNextTurnBatch(key);
      expect(claimed?.messageIds).toEqual([queued.id]);
      expect(claimed?.hasUserMessage).toBe(true);
    });

    it.each(["user", "generated"] as const)(
      "keeps the turn's ownership until asynchronous %s input preparation and delivery settle",
      async (inputOrigin) => {
        const h = await harness();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<null>();
        const reference =
          '<ticket-ref project-name="repo" ticket-number="1" identifier="REPO-1" title="Ticket" read-command="cctl ticket show 1" />';
        h.inputDeps.context.readNotepadForInjection = async () => ({
          id: "notes",
          name: "Notes",
          revision: 7,
          content: reference,
          writeMode: "full-edit",
          openComments: { count: 0, latestCreatedAt: null },
        });
        h.inputDeps.context.readLiveReference = async () => {
          entered.resolve();
          return resume.promise;
        };
        const sending = h.send(
          inputOrigin === "user"
            ? reference
            : '<notepad-ref notepad-id="notes" />',
          { inputOrigin },
        );
        await entered.promise;
        let settled = false;
        void h.ended.then(() => {
          settled = true;
        });
        h.endTurn();
        await Promise.resolve();
        expect(settled).toBe(false);
        resume.resolve(null);
        await sending;
        await h.ended;
        expect(h.received).toHaveLength(1);
        expect((await h.reload())?.pendingQueue).toEqual([]);
      },
    );

    it("keeps a live message pending when the core declines admission", async () => {
      const h = await harness();
      let preparations = 0;
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          preparations++;
          return {
            block: "Update",
            onInputAccepted: async () => {},
            finish: async () => {},
          };
        },
      };
      h.deps.core!.acceptsLive = async () => false;
      const sent = await h.send();
      expect(sent.deliveryTiming).toBe("next_turn");
      expect(h.received).toEqual([]);
      expect(preparations).toBe(0);
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("continues after archive when settlement fails, holding review and blocking redelivery", async () => {
      const h = await harness();
      h.settlement.confirm = async () => {
        throw new Error("settlement unavailable");
      };
      const result = await h.send();
      expect(result.deliveryTiming).toBe("in_turn");
      expect(h.outputs).toEqual(["hello"]);
      expect(h.archive).toHaveLength(1);
      await h.send("later");
      expect(h.outputs).toEqual(["hello"]);
      expect(
        (await h.reload())?.pendingQueue.map((entry) => entry.status),
      ).toEqual(["uncertain", "pending"]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("does not recreate a row pruned before settlement reporting failed", async () => {
      const h = await harness();
      h.settlement.confirm = async (input) => {
        await h.service.confirmDelivery(input);
        throw new Error("settlement reporting failed");
      };
      await h.send();
      expect(h.outputs).toEqual(["hello"]);
      expect(h.archive).toHaveLength(1);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("retains the delivering claim if the uncertain write also fails", async () => {
      const h = await harness();
      h.settlement.confirm = async () => {
        throw new Error("settlement unavailable");
      };
      h.settlement.uncertain = async () => {
        throw new Error("store unavailable");
      };
      await h.send();
      await h.send("later");
      expect(h.outputs).toEqual(["hello"]);
      expect(
        (await h.reload())?.pendingQueue.map((entry) => entry.status),
      ).toEqual(["delivering", "pending"]);
    });

    it("rejects archival without returning accepted input to pending", async () => {
      const h = await harness();
      h.failures.archive = true;
      const result = await h.send();
      expect(result.deliveryTiming).toBe("in_turn");
      expect(h.received).toHaveLength(1);
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("uncertain");
    });

    it("delivers queued image bytes with text and archives image references once", async () => {
      const h = await harness();
      const image = {
        attachmentId: "image",
        mediaType: "image/png" as const,
        base64Data: "aW1hZ2U=",
      };
      const result = await h.send("look at this", { images: [image] });
      expect(result.deliveryTiming).toBe("in_turn");
      expect(h.received).toHaveLength(1);
      expect(h.received[0]?.content).toContainEqual({
        type: "image",
        mediaType: image.mediaType,
        base64Data: image.base64Data,
      });
      expect(h.received[0]?.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("look at this"),
      });
      expect(h.archive).toHaveLength(1);
      expect(h.archive[0]?.content).toContainEqual({
        type: "image_ref",
        mediaType: image.mediaType,
        imagePath: `/repo/.cc/images/${key.conversationId}/1.png`,
      });
      expect(JSON.stringify(h.archive[0])).not.toContain(image.base64Data);
      expect(h.order).toEqual(["image", "send", "archive", "release"]);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("keeps an image persistence failure pending before dispatch", async () => {
      const h = await harness();
      h.imageIO.getNextImageIndex = async () => 1;
      h.imageIO.saveTranscriptImage = async () => {
        throw new Error("image archive unavailable");
      };
      const result = await queueMessage({
        ...key,
        backend: "claude",
        text: "inspect",
        images: [
          { attachmentId: "image", mediaType: "image/png", base64Data: "AAAA" },
        ],
        deps: h.deps,
      });
      expect(result.deliveryTiming).toBe("next_turn");
      expect(h.archive).toEqual([]);
      expect(h.received).toEqual([]);
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("persists promptly and preserves order before asynchronous reference preparation", async () => {
      const h = await harness();
      const slow = Promise.withResolvers<null>();
      const entered = Promise.withResolvers<void>();
      h.inputDeps.context.readNotepadForInjection = async () => {
        entered.resolve();
        return slow.promise;
      };
      const first = h.send(
        '<notepad-ref notepad-id="first" name="First" scope="global" read-command="cctl notepad get first" />',
      );
      await entered.promise;
      const second = h.send("second");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(h.outputs).toEqual([]);
      const queuedCount = (await h.reload())?.pendingQueue.length;
      slow.resolve(null);
      await Promise.all([first, second]);
      expect(queuedCount).toBe(2);
      expect(h.outputs).toEqual([
        expect.stringContaining("id: first"),
        "second",
      ]);
    });
  },
);
