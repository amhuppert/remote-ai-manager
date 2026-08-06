/**
 * R8.1 sequencing — admission is AWAITED before `SUBMIT_PROMPT` reaches the
 * actor, on both paths that produce one.
 *
 * The test holds admission open on a deferred promise and asserts the actor has
 * received nothing while it is pending. That is the property the requirement
 * names: not "admission is also called", but "the prompt does not reach the
 * runtime until the profile is settled". An implementation that fired admission
 * without awaiting it would pass a call-count assertion and fail this one.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  executeConversationTurn,
  getActorRegistry,
} from "@/lib/workflows/conversation/manager";
import { conversationRuntimeKey } from "@/lib/workflows/conversation/runtime-state";
import {
  drainConversationQueue,
  type ConversationQueueDeps,
  type DrainSelf,
} from "./message-queue-drain";
import {
  setConversationProfileAdmissionDeps,
  _resetConversationProfileAdmissionDepsForTesting,
  type ConversationProfileAdmissionDeps,
} from "./profile-admission";
import type { ConversationEvent } from "@/lib/workflows/conversation/types";
import type { ConversationActorRef } from "@/lib/workflows/conversation/machine";
import type { ConversationState } from "./schemas";

const PROJECT_PATH = "/repo-ordering";
const SESSION_NAME = "ordering-session";
const CONVERSATION_ID = "ordering-conv";

interface Deferred {
  promise: Promise<void>;
  release(): void;
}

function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/**
 * A store seam whose write does not settle until released — standing in for any
 * real durable write that has not yet reached disk.
 */
function blockingAdmissionDeps(
  gate: Deferred,
): ConversationProfileAdmissionDeps {
  return {
    async mutateConversation(_p, _s, _c, _label, mutate) {
      await gate.promise;
      return mutate({
        profileSnapshot: null,
        profileLockedAt: null,
      } as unknown as ConversationState);
    },
  };
}

/**
 * The narrow slice of the actor `executeConversationTurn` touches: acceptance,
 * dispatch, and the settled projection it reads back. It reports "idle" so the
 * turn resolves immediately after the send, keeping the assertion on ordering
 * rather than on a simulated turn.
 */
function recordingActor(received: ConversationEvent[]) {
  return {
    getSnapshot: () => ({
      can: () => true,
      value: "idle",
      status: "active",
      context: {
        totals: { contextTokens: null, contextWindowMax: null },
        lastResult: null,
        lastError: null,
      },
    }),
    send: (event: ConversationEvent) => {
      received.push(event);
    },
  };
}

afterEach(() => {
  _resetConversationProfileAdmissionDepsForTesting();
  getActorRegistry().clear();
});

describe("executeConversationTurn", () => {
  it("does not send SUBMIT_PROMPT until admission resolves", async () => {
    const gate = deferred();
    setConversationProfileAdmissionDeps(blockingAdmissionDeps(gate));

    const received: ConversationEvent[] = [];
    getActorRegistry().set(
      conversationRuntimeKey(PROJECT_PATH, SESSION_NAME, CONVERSATION_ID),
      recordingActor(received) as unknown as ConversationActorRef,
    );

    const turn = executeConversationTurn({
      projectPath: PROJECT_PATH,
      sessionName: SESSION_NAME,
      conversationId: CONVERSATION_ID,
      streamId: "stream-ordering",
      emit: () => {},
      turn: { promptText: "Hello", backend: "claude" },
    });

    // Let every already-resolvable continuation run. The prompt must still be
    // held: admission has not committed.
    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([]);

    gate.release();
    await turn.catch(() => undefined);

    expect(received.map((event) => event.type)).toContain("SUBMIT_PROMPT");
  });
});

describe("drainConversationQueue", () => {
  it("does not send a queued SUBMIT_PROMPT until admission resolves", async () => {
    const gate = deferred();
    setConversationProfileAdmissionDeps(blockingAdmissionDeps(gate));

    const received: ConversationEvent[] = [];
    const self: DrainSelf = {
      getSnapshot: () => ({ can: () => true }),
      send: (event) => {
        received.push(event);
      },
    };

    const deps = {
      claimNextTurnBatch: async () => ({
        messageIds: ["m1"],
        deliveryAttemptId: "attempt-1",
        content: [{ type: "text" as const, text: "queued hello" }],
        command: null,
      }),
      markPending: async () => {},
      markFailed: async () => {},
      markDelivered: async () => {},
      runConversationCommand: async () => {
        throw new Error("not a command batch");
      },
    } as unknown as ConversationQueueDeps;

    const drain = drainConversationQueue(
      self,
      {
        projectPath: PROJECT_PATH,
        sessionName: SESSION_NAME,
        conversationId: CONVERSATION_ID,
        projectName: "repo-ordering",
      } as Parameters<typeof drainConversationQueue>[1],
      deps,
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(received).toEqual([]);

    gate.release();
    await drain;

    expect(received.map((event) => event.type)).toEqual(["SUBMIT_PROMPT"]);
  });
});
