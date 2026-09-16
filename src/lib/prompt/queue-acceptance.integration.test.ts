import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import type { TranscriptEntry } from "./transcript";
import { queueMessage, type QueueMessageDeps } from "./queue";

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
        outputFormat: undefined,
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
        prepareNotepadChangeNotice: async () => ({
          conversationId: key.conversationId,
          block: null,
          advances: [],
        }),
        settleNotepadChangeNotice: async () => {},
        appendTranscriptEntry: async (_id, entry) => {
          archive.push(entry);
        },
      };
      const send = (text = "hello") =>
        queueMessage({ ...key, backend: "claude", text, deps });
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
