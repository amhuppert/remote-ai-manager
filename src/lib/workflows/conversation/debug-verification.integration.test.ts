import type { DebugCleanupVerificationRequest } from "@/lib/workflows/debug/cleanup-verification";
import { expect, it, vi } from "vitest";
import { debugModeStateSchema } from "@/lib/debug-log/schemas";
import type { DebugCommand } from "@/lib/workflows/debug/commands";
import { capabilityViewForBackend } from "@/lib/workflows/primitives/backend-capabilities";
import { setConversationPersistenceAdapterDeps } from "./persistence-adapter";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

async function cleanupFixture() {
  const verification = deferred<DebugCommand | null>();
  const verify = vi.fn(
    (_input: DebugCleanupVerificationRequest) => verification.promise,
  );
  const fixture = await createLifecycleFixture({
    conversation: {
      debugMode: debugModeStateSchema.parse({
        active: true,
        recording: true,
        phase: "cleanup_instrumentation",
        logFilePath: "/debug/log",
        enteredAt: new Date(0).toISOString(),
        debugSessionId: "debug-a",
      }),
    },
    verifyDebugCleanup: verify,
    actorDeps: {
      executeAgentCall: async () => ({
        backend: "claude",
        backendRef: { backend: "claude", ref: "cleanup-ref" },
        capabilities: capabilityViewForBackend("claude"),
        usage: { costUsd: 0.7, durationMs: 42 },
        artifacts: [],
        outcome: {
          kind: "completed",
          text: "Cleaned",
          numTurns: 1,
          structuredOutput: {
            removedInstrumentation: true,
            filesModified: [],
            grepVerificationPassed: true,
            acknowledgesManifestDeletionContract: true,
            notes: "Done",
          },
        },
      }),
    },
  });
  await fixture.manager.executeConversationTurn({
    binding: fixture.binding,
    turn: { promptText: "Clean up" },
  });
  await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
  return { ...fixture, verification, verify };
}

it("serializes verification completion behind a pending durable debug command and accounts once", async () => {
  const fixture = await cleanupFixture();
  const write = delayConversationWrites(fixture);
  const recording = fixture.manager.executeConversationCommand(
    fixture.binding.address,
    { kind: "set_recording", recording: false },
  );
  try {
    await write.started();
    fixture.verification.resolve({
      kind: "cleanup_verified",
      debugSessionId: "debug-a",
      attempt: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      fixture
        .actor(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
        ?.getSnapshot().context.debugMode?.active,
    ).toBe(true);
    write.resolve();
    await recording;
    await vi.waitFor(async () => {
      const row = await readConversation(fixture);
      expect(row).toMatchObject({
        debugMode: null,
        promptCount: 1,
        totalCostUsd: 0.7,
        totalDurationMs: 42,
        totalTurns: 1,
        backendRef: { backend: "claude", ref: "cleanup-ref" },
      });
    });
  } finally {
    write.resolve();
    fixture.verification.resolve(null);
    await recording;
    await fixture.close();
  }
});

it("finishes exit when verification queues behind it, then rejects the old generation", async () => {
  const fixture = await cleanupFixture();
  const write = delayConversationWrites(fixture);
  const recording = fixture.manager.executeConversationCommand(
    fixture.binding.address,
    { kind: "set_recording", recording: false },
  );
  await write.started();
  const exit = fixture.manager.executeConversationCommand(
    fixture.binding.address,
    { kind: "exit" },
  );
  try {
    fixture.verification.resolve({
      kind: "cleanup_verified",
      debugSessionId: "debug-a",
      attempt: 1,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    write.resolve();
    expect(await exit).toEqual({ kind: "applied" });
    await fixture.manager.executeConversationCommand(fixture.binding.address, {
      kind: "enter",
      debugSessionId: "debug-b",
      logFilePath: "/debug/b",
    });
    expect(
      await fixture.manager.executeConversationCommand(
        fixture.binding.address,
        { kind: "cleanup_verified", debugSessionId: "debug-a", attempt: 1 },
      ),
    ).toMatchObject({ kind: "refused" });
    expect((await readConversation(fixture))?.debugMode?.debugSessionId).toBe(
      "debug-b",
    );
  } finally {
    write.resolve();
    fixture.verification.resolve(null);
    await recording;
    await exit;
    await fixture.close();
  }
});

it("waits for cancelled verification before rebinding and fences its completion", async () => {
  const fixture = await cleanupFixture();
  const original = fixture.actor(
    fixture.identity.projectPath,
    fixture.identity.sessionName,
    fixture.identity.conversationId,
  );
  const stopping = fixture.manager.requestConversationStop(
    fixture.binding.address,
    "user",
  );
  let rebound = false;
  let rebindError: unknown;
  const replacement = fixture.manager
    .ensureConversationLifecycle({
      ...fixture.binding,
      worktreePath: "/debug-rebound",
    })
    .then(
      () => {
        rebound = true;
      },
      (error: unknown) => {
        rebindError = error;
      },
    );
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stopping.requested).toBe(true);
    expect(fixture.verify.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(rebindError).toBeUndefined();
    expect(rebound).toBe(false);
    fixture.verification.resolve({
      kind: "cleanup_verified",
      debugSessionId: "debug-a",
      attempt: 1,
    });
    await stopping.settled;
    await replacement;
    const actor = fixture.actor(
      fixture.identity.projectPath,
      fixture.identity.sessionName,
      fixture.identity.conversationId,
    );
    expect(actor).not.toBe(original);
    expect(actor?.getSnapshot().context.worktreePath).toBe("/debug-rebound");
    expect(actor?.getSnapshot().context.debugMode?.debugSessionId).toBe(
      "debug-a",
    );
  } finally {
    fixture.verification.resolve(null);
    await stopping.settled;
    await replacement;
    await fixture.close();
  }
});

it("accounts each retried cleanup execution once and does not account verification again", async () => {
  const fixture = await cleanupFixture();
  try {
    fixture.verification.resolve({
      kind: "cleanup_verification_failed",
      debugSessionId: "debug-a",
      attempt: 1,
      message: "One probe remains",
    });
    await vi.waitFor(async () =>
      expect((await readConversation(fixture))?.debugMode?.lastTurnFailed).toBe(
        true,
      ),
    );
    fixture.verify.mockImplementation(async (input) => ({
      kind: "cleanup_verified",
      debugSessionId: input.debugSessionId,
      attempt: input.attempt,
    }));
    expect(
      await fixture.manager.retryConversationTurn(
        fixture.identity.projectPath,
        fixture.identity.sessionName,
        fixture.identity.conversationId,
      ),
    ).toBe(true);
    await vi.waitFor(async () =>
      expect(await readConversation(fixture)).toMatchObject({
        debugMode: null,
        promptCount: 2,
        totalCostUsd: 1.4,
        totalDurationMs: 84,
        totalTurns: 2,
        backendRef: { backend: "claude", ref: "cleanup-ref" },
      }),
    );
    expect(fixture.verify).toHaveBeenCalledTimes(2);
  } finally {
    fixture.verification.resolve(null);
    await fixture.close();
  }
});

function readConversation(fixture: Awaited<ReturnType<typeof cleanupFixture>>) {
  return fixture.persistence.store.getConversation(
    fixture.identity.projectPath,
    fixture.identity.sessionName,
    fixture.identity.conversationId,
  );
}

function delayConversationWrites(
  fixture: Awaited<ReturnType<typeof cleanupFixture>>,
) {
  const write = deferred<void>();
  let writing = false;
  setConversationPersistenceAdapterDeps({
    mutateConversation: async (...args) => {
      writing = true;
      await write.promise;
      return fixture.persistence.store.mutateConversation(...args);
    },
    publishSessionStatus: () => ({ delivered: true }),
    queueAutoName: () => {},
  });
  return {
    resolve: write.resolve,
    started: () => vi.waitFor(() => expect(writing).toBe(true)),
  };
}
