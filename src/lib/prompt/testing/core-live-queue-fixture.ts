/** Real queue, interactive turns and receipt accounting with scripted provider/storage I/O. */
import type {
  ConversationBackendRuntime,
  ConversationQueuedUserInput,
} from "@/lib/agent-backends/conversation";
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
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import type { PersistenceFixture } from "@/lib/shared/testing/persistence-fixture";
import {
  queueMessage,
  type QueueMessageDeps,
  type QueueMessageParams,
} from "../queue";
import type { TranscriptEntry } from "../transcript";

import {
  persistTurnImages,
  type ImagePersistenceDeps,
} from "@/lib/conversation-core/contributions/image-persistence";

function completed(): TurnExecutionOutcome {
  const execution = settledConversationTurn({
    outcome: { kind: "completed", text: "Done." },
  });
  if (execution.kind !== "settled") throw new Error("fixture");
  return execution.turn.outcome;
}

export function createCoreLiveQueueHarness(
  fixture: PersistenceFixture,
  key: { projectPath: string; sessionName: string; conversationId: string },
) {
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
  const received: ConversationQueuedUserInput[] = [];
  const outputs: string[] = [];
  const failures = { archive: false, release: false, uncertain: false };
  const settlement = {
    confirm: service.confirmDelivery,
    uncertain: service.markUncertain,
  };
  const imageIO: ImagePersistenceDeps = {
    getNextImageIndex: async () => 1,
    saveTranscriptImage: async (conversationId, index) => {
      order.push("image");
      return `/repo/.cc/images/${conversationId}/${index}.png`;
    },
  };
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
      received.push(input);
      sent.push(
        input.content
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join(""),
      );
      await input.onAccepted?.();
      outputs.push(sent.at(-1) ?? "");
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
    persistImages: async (input) => {
      const persisted = await persistTurnImages(imageIO, input);
      return {
        promptText: persisted.assembled.rewrittenPromptText,
        imageRefs: persisted.imageRefs,
      };
    },
    queuedDelivery: ({ identity: owner, delivery, appendUserEntry }) =>
      createQueuedDeliveryAccounting(
        {
          markQueuedUncertain: async (input) => {
            if (failures.uncertain) throw new Error("store unavailable");
            return settlement.uncertain(input);
          },
          async confirmQueuedDelivery(input) {
            if (failures.release) throw new Error("settlement unavailable");
            order.push("release");
            return settlement.confirm(input);
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
  const send = (
    text = "hello",
    extra: Partial<
      Omit<
        QueueMessageParams,
        "projectPath" | "sessionName" | "conversationId" | "deps"
      >
    > = {},
  ) =>
    queueMessage({
      ...key,
      backend: "claude",
      text,
      inputOrigin: "user",
      ...extra,
      deps,
    });
  const reload = () =>
    fixture
      .recreateStore()
      .getConversation(key.projectPath, key.sessionName, key.conversationId);
  return {
    service,
    order,
    archive,
    sent,
    received,
    outputs,
    failures,
    settlement,
    imageIO,
    turns,
    deps,
    runtime,
    inputDeps,
    identity,
    startTurn,
    endTurn: () => finish.resolve(),
    send,
    reload,
  };
}
