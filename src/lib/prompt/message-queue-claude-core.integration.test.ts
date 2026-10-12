/**
 * Claude live input through the conversation core (design C5b §4.2): the
 * core equivalents of the actor-path suites `message-queue-claude-in-turn`
 * and `queue-acceptance`. The real queue, the core's interactive turns, the
 * production turn input, queue accounting and conversation records over a
 * persistence fixture; the provider is a Claude-shaped runtime at its I/O
 * boundary, one whose input may be answered after the turn's result.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ConversationBackendRuntime,
  ConversationQueuedUserInput,
} from "@/lib/agent-backends/conversation";
import { InputDeliveryUncertainError } from "@/lib/agent-backends/errors";
import { createQueuedDeliveryAccounting } from "@/lib/conversation-core/contributions/queued-delivery-accounting";
import { createInteractiveTurns } from "@/lib/conversation-core/interactive-turns";
import { createProductionConversationRecords } from "@/lib/conversation-core/production-records";
import {
  noCustody,
  noCustodyOpener,
} from "@/lib/conversation-core/testing/no-custody";
import {
  prepareTurnInput,
  type TurnInputDependencies,
} from "@/lib/conversation-core/turn-input";
import { settledConversationTurn } from "@/lib/conversation-core/turn/testing/turn-result-fixture";
import type { TurnExecutionOutcome } from "@/lib/conversation-core/turn/turn-result";
import { createMessageQueueService } from "@/lib/conversations/message-queue-service";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { makeConversationState } from "@/lib/conversations/testing/conversation-state-fixture";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import {
  createPersistenceFixture,
  type PersistenceFixture,
} from "@/lib/shared/testing/persistence-fixture";
import { queueMessage, type QueueMessageDeps } from "./queue";
import type { TranscriptEntry } from "./transcript";

function completed(): TurnExecutionOutcome {
  const execution = settledConversationTurn({
    outcome: { kind: "completed", text: "Done." },
  });
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

describe.each(["session", "project"] as const)(
  "Claude live input through the core's running turn (%s)",
  (scope) => {
    let fixture: PersistenceFixture;
    const key = {
      projectPath: "/repo",
      sessionName:
        scope === "project" ? PROJECT_CONVERSATION_SESSION_SENTINEL : "session",
      conversationId: `claude-live-${scope}`,
    };
    const PROMPTS_BEFORE = 4;

    beforeEach(async () => {
      fixture = createPersistenceFixture();
      fixture.seedProject(key.projectPath);
      const conversation = makeConversationState({
        id: key.conversationId,
        status: "awaiting",
        agentBackend: "claude",
        promptCount: PROMPTS_BEFORE,
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
      const order: string[] = [];
      const archive: TranscriptEntry[] = [];
      const sent: string[] = [];
      const failures = { archive: false, release: false };
      const runtime: ConversationBackendRuntime = {
        backend: "claude",
        status: "alive",
        modelSelection: { modelId: "opus", parameters: {} },
        liveInput: "until_answered",
        sendTurn: async () => {
          throw new Error("the turn runs through the engine");
        },
        close: async () => {},
        async queueUserInput(input: ConversationQueuedUserInput) {
          order.push("send");
          sent.push(
            input.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join(""),
          );
          await input.onAccepted?.();
        },
      };
      const inputDeps: TurnInputDependencies = {
        context: {
          getLiveTicketBlock: async () => null,
          getMemoryIndexBlock: async () => null,
          readLiveReference: async () => null,
          readNotepadForInjection: async () => null,
        },
        effects: {
          recordNotepadDeliveries: async () => {},
          recordMemoryIndexDeliveries: async () => {},
          mutateConversation: async () => {},
          prepareRuntimeLossNotice: async () => ({
            block: null,
            onInputAccepted: async () => {},
            finish: async () => {},
          }),
        },
        debug: { getDebugLogUrl: () => "http://debug" },
        log: createCapturingLogger(),
      };
      const records = {
        ...createProductionConversationRecords({
          db: () => fixture.db,
          getConversation: fixture.store.getConversation,
          mutateConversation: fixture.store.mutateConversation,
          queue: service,
        }),
        admitProfile: async () => ({
          instructionBlock: null,
          snapshot: null,
          lockedAt: null,
        }),
      };
      const identity = {
        projectPath: key.projectPath,
        storeSessionName: key.sessionName,
        conversationId: key.conversationId,
      };
      const running = Promise.withResolvers<void>();
      const finish = Promise.withResolvers<void>();
      const turns = createInteractiveTurns({
        engine: {
          async runTurn(turn) {
            await turn.onEvent?.({ type: "input_accepted" });
            running.resolve();
            await finish.promise;
            return completed();
          },
        },
        records,
        host: {
          release: async () => {},
          isLive: () => false,
          runtime: () => runtime,
          alignment: () => null,
        },
        custody: noCustody,
        worktreeOf: async () => "/repo/.worktrees/session",
        admitCheckpointFork: async () => null,
        resolveModelSelection: async () => ({
          modelId: "opus",
          parameters: {},
        }),
        continuation: async () => ({
          continuation: { kind: "ordinary" },
          seed: null,
        }),
        prepareInput: (request) => prepareTurnInput(inputDeps, request),
        nameConversation: () => {},
        requestUserQuestion: async () => ({
          status: "answered" as const,
          answers: {},
        }),
        persistImages: async ({ promptText }) => ({
          promptText,
          imageRefs: [],
        }),
        queuedDelivery: ({ identity: owner, delivery, appendUserEntry }) =>
          createQueuedDeliveryAccounting(
            {
              markQueuedUncertain: (input) => service.markUncertain(input),
              async confirmQueuedDelivery(input) {
                if (failures.release) throw new Error("settlement unavailable");
                order.push("release");
                return service.confirmDelivery(input);
              },
            },
            {
              projectPath: owner.projectPath,
              sessionName: owner.storeSessionName,
              conversationId: owner.conversationId,
              queuedDelivery: delivery,
              appendUserEntry,
            },
          ),
        failQueued: ({ identity: owner, delivery, error }) =>
          service.markFailed({
            projectPath: owner.projectPath,
            sessionName: owner.storeSessionName,
            conversationId: owner.conversationId,
            ids: delivery.messageIds,
            deliveryAttemptId: delivery.deliveryAttemptId,
            error,
          }),
        returnQueued: ({ identity: owner, delivery, error }) =>
          service.markPending({
            projectPath: owner.projectPath,
            sessionName: owner.storeSessionName,
            conversationId: owner.conversationId,
            ids: delivery.messageIds,
            deliveryAttemptId: delivery.deliveryAttemptId,
            error,
          }),
        transcript: {
          async appendTranscriptEntryOnce(_conversationId, entry) {
            if (failures.archive) throw new Error("archive unavailable");
            order.push("archive");
            archive.push(entry);
          },
        },
        getProjectDisplayName: () => "repo",
        startDebugVerification: () => {},
        log: createCapturingLogger(),
      });
      const deps: Partial<QueueMessageDeps> = {
        core: {
          owns: async () => true,
          acceptsLive: (conversationId) => turns.acceptsLive(conversationId),
          deliverLive: (owner, request) => turns.deliverLive(owner, request),
        },
        enqueue: service.enqueue,
        claimLiveDelivery: service.claimLiveDelivery,
        markDelivered: service.markDelivered,
        markPending: service.markPending,
        markUncertain: service.markUncertain,
        getRuntime: () => runtime,
        getProjectDisplayName: () => "repo",
      };
      /** A turn of the conversation, held running until `endTurn`; `ended` settles with it. */
      async function startTurn(): Promise<{ ended: Promise<unknown> }> {
        const turn = turns.run({
          conversationId: key.conversationId,
          place: {
            conversationId: key.conversationId,
            projectPath: key.projectPath,
            sessionName: key.sessionName,
          },
          request: {
            kind: "user_message",
            text: "Start the release",
            inputOrigin: "user",
          },
          attemptId: "turn-1",
          signal: new AbortController().signal,
          stream: null,
          custody: noCustodyOpener,
        });
        await Promise.race([
          running.promise,
          turn.then((ended) => {
            throw new Error(
              `The turn ended before it ran: ${JSON.stringify(ended)}`,
            );
          }),
        ]);
        return { ended: turn };
      }
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
      return {
        service,
        order,
        archive,
        sent,
        failures,
        runtime,
        inputDeps,
        identity,
        startTurn,
        endTurn: () => finish.resolve(),
        send,
        reload,
      };
    }

    it("queues during a running Claude turn, delivers it into the turn on acceptance, archives it once and releases the row (pending → delivered)", async () => {
      const h = harness();
      const turn = await h.startTurn();
      const result = await h.send("live message");

      expect(result).toMatchObject({
        entry: { status: "pending" },
        deliveryTiming: "in_turn",
      });
      expect(h.sent).toEqual(["live message"]);
      expect(h.order).toEqual(["send", "archive", "release"]);
      expect(h.archive).toHaveLength(1);
      expect(h.archive[0]).toMatchObject({
        id: result.entry.id,
        type: "user",
        role: "user",
        content: [{ type: "text", text: "live message" }],
      });
      const reloaded = await h.reload();
      expect(reloaded?.pendingQueue).toEqual([]);
      // An input the provider may answer after the turn counts as a prompt once accepted.
      expect(reloaded?.promptCount).toBe(PROMPTS_BEFORE + 1);
      expect(await h.service.listActive(key)).toEqual([]);

      h.endTurn();
      await turn.ended;
      expect((await h.reload())?.promptCount).toBe(PROMPTS_BEFORE + 2);
    });

    it("holds a lost live acknowledgement for review without next-turn redelivery", async () => {
      const h = harness();
      h.runtime.queueUserInput = async () => {
        throw new InputDeliveryUncertainError("acknowledgement lost");
      };
      const turn = await h.startTurn();
      const result = await h.send("only once");
      h.endTurn();
      await turn.ended;

      expect(result.entry.status).toBe("uncertain");
      expect(h.archive).toEqual([]);
      const reloaded = await h.reload();
      expect(reloaded?.pendingQueue).toMatchObject([{ status: "uncertain" }]);
      expect(reloaded?.promptCount).toBe(PROMPTS_BEFORE + 1);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("attaches a passive briefing to live user input, accepted with it, without recording it as the person's text", async () => {
      const h = harness();
      let briefing = "pending";
      h.inputDeps.subscriptions = {
        prepareBriefing: async () => {
          briefing = "queued";
          return {
            block: "<passive-briefing>Latest update</passive-briefing>",
            onInputAccepted: async () => {
              briefing = "accepted";
            },
            finish: async () => {},
          };
        },
      };
      const turn = await h.startTurn();
      briefing = "pending";
      await h.send();

      expect(briefing).toBe("accepted");
      expect(h.sent[0]).toContain(
        "<passive-briefing>Latest update</passive-briefing>",
      );
      expect(h.sent[0]).toContain("hello");
      expect(h.archive[0]?.content).toEqual([{ type: "text", text: "hello" }]);
      expect((await h.reload())?.pendingQueue).toEqual([]);
      h.endTurn();
      await turn.ended;
    });

    it("holds a live delivery the runtime never confirmed as uncertain, with its briefing", async () => {
      const h = harness();
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
      const turn = await h.startTurn();
      h.runtime.queueUserInput = async () => {};
      const result = await h.send();
      h.endTurn();
      await turn.ended;

      expect(result.entry.status).toBe("uncertain");
      expect(disposition).toBe("uncertain");
      expect((await h.reload())?.pendingQueue).toMatchObject([
        { status: "uncertain" },
      ]);
    });

    it("holds accepted input whose archive failed for review, never returning it to pending", async () => {
      const h = harness();
      const turn = await h.startTurn();
      h.failures.archive = true;
      await h.send();
      h.endTurn();
      await turn.ended;

      expect(h.sent).toEqual(["hello"]);
      expect(h.archive).toEqual([]);
      expect((await h.reload())?.pendingQueue).toMatchObject([
        { status: "uncertain" },
      ]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });

    it("holds accepted input whose release failed for review, and delivers nothing past it", async () => {
      const h = harness();
      const turn = await h.startTurn();
      h.failures.release = true;
      await h.send();
      await h.send("later");
      h.endTurn();
      await turn.ended;

      expect(h.sent).toEqual(["hello"]);
      expect(h.archive).toHaveLength(1);
      expect(
        (await h.reload())?.pendingQueue.map((entry) => entry.status),
      ).toEqual(["uncertain", "pending"]);
      expect(await h.service.claimNextTurnBatch(key)).toBeNull();
    });
  },
);
