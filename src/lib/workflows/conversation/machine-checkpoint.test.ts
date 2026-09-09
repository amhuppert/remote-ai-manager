/**
 * The machine's share of checkpoint maintenance: the `{operationId, phase}`
 * projection holds ordinary admission while a checkpoint owns the host, and a
 * `ready` projection retires the continuation in the same transition.
 */

import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createConversationMachineFixture } from "@/lib/workflows/conversation/testing/machine-fixture";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActor, type AnyActorRef } from "xstate";

import type { ConversationInput } from "./types";

const activeActors: AnyActorRef[] = [];

afterEach(() => {
  for (const actor of activeActors) {
    try {
      actor.stop();
    } catch {
      /* already stopped */
    }
  }
  activeActors.length = 0;
});

const input: ConversationInput = {
  lastActivityAt: "2026-01-01T00:00:00Z",
  totalCostUsd: null,
  totalDurationMs: null,
  totalTurns: null,
  contextTokens: null,
  contextWindowMax: null,
  projectPath: "/repo",
  target: targetFromStoreSessionName("my-project", "sess-1", "conv-ckpt"),
  worktreePath: "/repo/.worktrees/sess-1",
  createdAt: "2026-01-01T00:00:00Z",
  forkedFrom: null,
  role: null,
  transcriptPath: "/repo/transcript.jsonl",
  agentBackend: "claude",
  backendRef: { backend: "claude", ref: "sdk-session-live" },
  promptCount: 2,
  persistence: "durable",
};

function start(overrides: Partial<ConversationInput> = {}) {
  const actor = createActor(createConversationMachineFixture(), {
    input: { ...input, ...overrides },
  });
  activeActors.push(actor);
  actor.start();
  return actor;
}

const SUBMIT = {
  type: "SUBMIT_PROMPT",
  promptText: "hello",
  streamId: null,
} as const;

describe("conversation machine — checkpoint projection", () => {
  it("starts without a checkpoint and admits ordinary turns", () => {
    const actor = start();
    expect(actor.getSnapshot().context.checkpoint).toBeNull();
    expect(actor.getSnapshot().can(SUBMIT)).toBe(true);
    expect(actor.getSnapshot().can({ type: "EXTERNAL_TURN_STARTED" })).toBe(
      true,
    );
  });

  it.each([
    "building",
    "retiring",
    "delivering",
    "needs_reconciliation",
  ] as const)(
    "holds ordinary admission from the first idle entry while the loaded projection is %s, and external admission unless it is still building",
    (phase) => {
      const actor = start({ checkpoint: { operationId: "op-1", phase } });
      const snapshot = actor.getSnapshot();
      expect(snapshot.value).toBe("idle");
      expect(snapshot.can(SUBMIT)).toBe(false);
      expect(
        snapshot.can({
          type: "SUBMIT_TASK_RUN",
          kind: "task_run",
          promptText: "task",
          executionClass: "nongoverned-task",
        }),
      ).toBe(false);
      expect(snapshot.can({ type: "EXTERNAL_TURN_STARTED" })).toBe(
        phase === "building",
      );
      expect(
        snapshot.can({
          type: "DEBUG_COMMAND",
          command: {
            kind: "enter",
            logFilePath: "/repo/debug.log",
            debugSessionId: "dbg-1",
          },
        }),
      ).toBe(false);
    },
  );

  it("admits a provider-initiated turn during a build and keeps ordinary admission held until that turn settles", async () => {
    const actor = start({
      checkpoint: { operationId: "op-1", phase: "building" },
    });
    actor.send({ type: "EXTERNAL_TURN_STARTED" });
    expect(actor.getSnapshot().value).toBe("externalExecuting");
    // The build yields: the manager clears its projection, but the external
    // turn still owns the host.
    actor.send({ type: "CHECKPOINT_PHASE", checkpoint: null });
    expect(actor.getSnapshot().value).toBe("externalExecuting");
    expect(actor.getSnapshot().can(SUBMIT)).toBe(false);
    actor.send({ type: "ABORT_TURN", reason: "user" });
    await vi.waitFor(() => expect(actor.getSnapshot().value).toBe("idle"));
    expect(actor.getSnapshot().can(SUBMIT)).toBe(true);
  });

  it("releases admission once the manager projects ready, retiring the continuation", () => {
    const actor = start({
      checkpoint: { operationId: "op-1", phase: "building" },
    });
    actor.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: "op-1", phase: "retiring" },
    });
    expect(actor.getSnapshot().context.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-session-live",
    });
    expect(actor.getSnapshot().can(SUBMIT)).toBe(false);

    actor.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: "op-1", phase: "ready" },
    });
    const snapshot = actor.getSnapshot();
    expect(snapshot.value).toBe("idle");
    expect(snapshot.context.checkpoint).toEqual({
      operationId: "op-1",
      phase: "ready",
    });
    expect(snapshot.context.backendRef).toBeNull();
    expect(snapshot.can(SUBMIT)).toBe(true);
  });

  it("keeps the continuation when a build fails or is cancelled", () => {
    const actor = start();
    actor.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: "op-1", phase: "building" },
    });
    expect(actor.getSnapshot().can(SUBMIT)).toBe(false);
    actor.send({ type: "CHECKPOINT_PHASE", checkpoint: null });
    const snapshot = actor.getSnapshot();
    expect(snapshot.context.checkpoint).toBeNull();
    expect(snapshot.context.backendRef).toEqual({
      backend: "claude",
      ref: "sdk-session-live",
    });
    expect(snapshot.can(SUBMIT)).toBe(true);
  });

  it("does not re-enter idle for a projection change, so the entry drain does not refire", () => {
    let drains = 0;
    const actor = createActor(
      createConversationMachineFixture().provide({
        actions: {
          drainPendingQueue: () => {
            drains += 1;
          },
        },
      }),
      { input },
    );
    activeActors.push(actor);
    actor.start();
    expect(drains).toBe(1);
    actor.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: "op-1", phase: "building" },
    });
    actor.send({
      type: "CHECKPOINT_PHASE",
      checkpoint: { operationId: "op-1", phase: "ready" },
    });
    expect(drains).toBe(1);
    expect(actor.getSnapshot().value).toBe("idle");
  });

  it("tolerates a restored context that predates the projection", () => {
    const actor = start();
    const persisted = actor.getPersistedSnapshot() as unknown as {
      context: Record<string, unknown>;
    };
    delete persisted.context.checkpoint;
    const restored = createActor(createConversationMachineFixture(), {
      input,
      snapshot: persisted as never,
    });
    activeActors.push(restored);
    restored.start();
    expect(restored.getSnapshot().can(SUBMIT)).toBe(true);
  });
});
