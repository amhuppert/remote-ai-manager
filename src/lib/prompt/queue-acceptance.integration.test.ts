import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "./transcript";
import { queueMessage, type QueueMessageDeps } from "./queue";
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
        status: "running",
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
    afterEach(() => fixture.close());

    function harness() {
      let sequence = 0;
      const service = createMessageQueueService({
        ...fixture.deps,
        getProjectDisplayName: () => "repo",
        broadcast: () => {},
        now: () => new Date().toISOString(),
        newId: () => `message-${++sequence}`,
      });
      const archive: TranscriptEntry[] = [];
      const outputs: string[] = [];
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        modelSelection: { modelId: "opus", parameters: {} },
        sendTurn: async () => {
          throw new Error("unexpected turn");
        },
        close: async () => {},
        queueUserInput: async (input) => {
          await input.onAccepted?.();
          outputs.push(
            input.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join(""),
          );
        },
      };
      const deps: Partial<QueueMessageDeps> = {
        ...service,
        getRuntime: () => runtime,
        getProjectDisplayName: () => "repo",
        readLiveReference: async () => null,
        readNotepadForInjection: async () => null,
        recordNotepadDeliveries: async () => {},
        subscriptions: undefined,
        ownSubscriptionReceipt: () => true,
        appendTranscriptEntry: async (_id, entry) => {
          archive.push(entry);
        },
      };
      const send = (text = "hello") =>
        queueMessage({
          ...key,
          backend: "claude",
          text,
          inputOrigin: "user",
          deps,
        });
      const reload = () =>
        fixture
          .recreateStore()
          .getConversation(
            key.projectPath,
            key.sessionName,
            key.conversationId,
          );
      return { service, archive, outputs, runtime, deps, send, reload };
    }

    it("archives once before releasing the accepted response", async () => {
      const h = harness();
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

    it("attaches a passive briefing to live user input without recording it as user text", async () => {
      const h = harness();
      let state = "pending";
      h.deps.subscriptions = {
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
          text: "<passive-briefing>Latest update</passive-briefing>",
        });
        await input.onAccepted?.();
      };
      await h.send();
      expect(state).toBe("accepted");
      expect(h.archive[0]?.content).toEqual([{ type: "text", text: "hello" }]);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("leaves passive updates pending for generated ordinary text and question-answer input", async () => {
      const h = harness();
      let preparations = 0;
      h.deps.subscriptions = {
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
      const h = harness();
      const repo = createConversationSubscriptionsRepo(
        fixture.db,
        createWriteQueue(),
      );
      const service = createSubscriptionService({
        repo,
        isRecipientEligible: async () => true,
        readSource: async () => ({ cursor: null, facts: [], missing: true }),
      });
      h.deps.readNotepadForInjection = async () => ({
        id: "notes",
        name: "Notes",
        revision: 7,
        content: "Accepted notes",
        writeMode: "full-edit",
        openComments: { count: 0, latestCreatedAt: null },
      });
      h.deps.recordNotepadDeliveries = async () => {
        throw new Error("Source deleted before watermark persistence");
      };
      h.deps.subscriptions = {
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
      expect((await h.reload())?.pendingQueue).toMatchObject([
        {
          status: "uncertain",
          error: "Source deleted before watermark persistence",
        },
      ]);
      expect(h.archive).toHaveLength(1);
      expect(h.archive[0]).toMatchObject({
        id: "message-1",
        role: "user",
        content: [{ type: "text", text: '<notepad-ref notepad-id="notes" />' }],
      });
    });

    it("holds unconfirmed live briefing delivery as uncertain", async () => {
      const h = harness();
      let disposition: string | undefined;
      h.deps.subscriptions = {
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
      const h = harness();
      let fail = true;
      let accepted = false;
      let recorded = false;
      let dispatches = 0;
      const receipts: (() => Promise<void>)[] = [];
      h.deps.ownSubscriptionReceipt = (_input, finish) => {
        receipts.push(finish);
        return true;
      };
      const record = async () => {
        if (fail) throw new Error("receipt unavailable");
        recorded = true;
      };
      h.deps.subscriptions = {
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
      expect(sent.entry.status).toBe("uncertain");
      expect(receipts).toHaveLength(1);
      expect(recorded).toBe(false);
      fail = false;
      await receipts[0]?.();
      expect(recorded).toBe(true);
      expect(dispatches).toBe(1);
    });

    it("preserves explicit user provenance through a durable queued-message reload", async () => {
      const h = harness();
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
      "does not send %s input after its owner finalizes receipts during asynchronous preparation",
      async (inputOrigin) => {
        const h = harness();
        const entered = Promise.withResolvers<void>();
        const resume = Promise.withResolvers<null>();
        const receipts: (() => Promise<void>)[] = [];
        let disposition: string | undefined;
        let dispatches = 0;
        h.deps.ownSubscriptionReceipt = (_input, finish) => {
          receipts.push(finish);
          return true;
        };
        h.deps.subscriptions = {
          prepareBriefing: async () => ({
            block: "Update",
            onInputAccepted: async () => {},
            finish: async (options) => {
              disposition = options?.disposition;
            },
          }),
          recordAcceptedNotepadReferences: async () => {},
        };
        const reference =
          '<ticket-ref project-name="repo" ticket-number="1" identifier="REPO-1" title="Ticket" read-command="cctl ticket show 1" />';
        h.deps.readNotepadForInjection = async () => ({
          id: "notes",
          name: "Notes",
          revision: 7,
          content: reference,
          writeMode: "full-edit",
          openComments: { count: 0, latestCreatedAt: null },
        });
        h.deps.readLiveReference = async () => {
          entered.resolve();
          return resume.promise;
        };
        h.runtime.queueUserInput = async () => {
          dispatches++;
        };
        const sending = queueMessage({
          ...key,
          backend: "claude",
          inputOrigin,
          deps: h.deps,
          text:
            inputOrigin === "user"
              ? reference
              : '<notepad-ref notepad-id="notes" />',
        });
        await entered.promise;
        await receipts[0]?.();
        resume.resolve(null);
        await sending;
        expect(dispatches).toBe(0);
        expect(disposition).toBe(
          inputOrigin === "user" ? "not_sent" : undefined,
        );
        expect((await h.reload())?.pendingQueue[0]?.status).toBe("pending");
      },
    );

    it("keeps a live message pending when its host refuses receipt ownership", async () => {
      const h = harness();
      let disposition: string | undefined;
      let dispatches = 0;
      h.deps.ownSubscriptionReceipt = () => false;
      h.deps.subscriptions = {
        prepareBriefing: async () => ({
          block: "Update",
          onInputAccepted: async () => {},
          finish: async (options) => {
            disposition = options?.disposition;
          },
        }),
      };
      h.runtime.queueUserInput = async () => {
        dispatches++;
      };
      const sent = await h.send();
      expect(sent.deliveryTiming).toBe("next_turn");
      expect(dispatches).toBe(0);
      expect(disposition).toBe("not_sent");
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("pending");
    });

    it("continues after archive when settlement fails, holding review and blocking redelivery", async () => {
      const h = harness();
      h.deps.markDelivered = async () => {
        throw new Error("settlement unavailable");
      };
      const result = await h.send();
      expect(result.entry.status).toBe("uncertain");
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
      const h = harness();
      h.deps.markDelivered = async (input) => {
        await h.service.markDelivered(input);
        throw new Error("settlement reporting failed");
      };
      await h.send();
      expect(h.outputs).toEqual(["hello"]);
      expect(h.archive).toHaveLength(1);
      expect((await h.reload())?.pendingQueue).toEqual([]);
    });

    it("retains the delivering claim if the uncertain write also fails", async () => {
      const h = harness();
      h.deps.markDelivered = async () => {
        throw new Error("settlement unavailable");
      };
      h.deps.markUncertain = async () => {
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
      const h = harness();
      h.deps.appendTranscriptEntry = async () => {
        throw new Error("archive unavailable");
      };
      const result = await h.send();
      expect(result.entry.status).toBe("uncertain");
      expect(h.outputs).toEqual([]);
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("uncertain");
    });

    it("holds image archive failures before releasing the response", async () => {
      const h = harness();
      h.deps.getNextImageIndex = async () => 1;
      h.deps.saveTranscriptImage = async () => {
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
      expect(result.entry.status).toBe("uncertain");
      expect(h.archive).toEqual([]);
      expect(h.outputs).toEqual([]);
      expect((await h.reload())?.pendingQueue[0]?.status).toBe("uncertain");
    });

    it("persists promptly and preserves order before asynchronous reference preparation", async () => {
      const h = harness();
      const slow = Promise.withResolvers<null>();
      const entered = Promise.withResolvers<void>();
      h.deps.readNotepadForInjection = async () => {
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
