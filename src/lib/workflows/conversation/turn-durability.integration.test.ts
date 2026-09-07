import { expect, it, vi } from "vitest";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";

import { setConversationPersistenceAdapterDeps } from "./persistence-adapter";
import { setPersistenceDeps } from "./persistence";
import {
  getConversationRuntime,
  conversationRuntimeKey,
} from "./runtime-state";
import {
  setPublicationBroadcastForTesting,
  _resetPublicationForTesting,
} from "@/lib/events/publication";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

it("retries retained required receipts without dispatching another turn", async () => {
  let deliveries = 0;
  let dispatches = 0;
  const fixture = await createLifecycleFixture({
    actorDeps: {
      getTaskRunner: () => ({
        backend: "claude",
        async run() {
          dispatches++;
          const runtime = getConversationRuntime(
            conversationRuntimeKey("/lifecycle-fixture", "s", "c"),
          )!;
          runtime.attempt!.ownReceipt(async () => {
            if (++deliveries === 1) throw new Error("Delivery unavailable");
          });
          return {
            text: "Receipt result",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    },
  });
  const submission = {
    binding: fixture.binding,
    turn: {
      kind: "task_run" as const,
      executionClass: "nongoverned-task" as const,
      promptText: "Required receipt",
    },
  };
  try {
    const first = await fixture.manager.submitConversationTurn(submission);
    if (first.kind !== "accepted") throw new Error(first.message);
    expect((await first.turn.completed).outcome).toMatchObject({
      kind: "settlement_failed",
      code: "delivery_receipt",
    });
    expect(
      await fixture.manager.submitConversationTurn(submission),
    ).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    expect(deliveries).toBe(2);
    expect(dispatches).toBe(1);
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.promptCount,
    ).toBe(1);
  } finally {
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.close();
  }
});

it("joins concurrent reconciliation of the same retained receipt", async () => {
  const gate = deferred();
  let deliveries = 0;
  const fixture = await createLifecycleFixture({
    actorDeps: {
      getTaskRunner: () => ({
        backend: "claude",
        async run() {
          const runtime = getConversationRuntime(
            conversationRuntimeKey("/lifecycle-fixture", "s", "c"),
          )!;
          runtime.attempt!.ownReceipt(async () => {
            if (++deliveries === 1) throw new Error("Retry receipt");
            await gate.promise;
          });
          return {
            text: "One receipt",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    },
  });
  try {
    const admitted = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "Reconcile once",
      },
    });
    if (admitted.kind !== "accepted") throw new Error(admitted.message);
    await admitted.turn.completed;
    const first = fixture.manager.ensureConversationLifecycle(fixture.binding);
    await vi.waitFor(() => expect(deliveries).toBe(2));
    const second = fixture.manager.ensureConversationLifecycle(fixture.binding);
    await Promise.resolve();
    expect(deliveries).toBe(2);
    gate.resolve();
    await Promise.all([first, second]);
  } finally {
    gate.resolve();
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.close();
  }
});

it("rejects a failed recording command without publishing success and reconciles its retained state", async () => {
  const fixture = await createLifecycleFixture();
  const recordings: boolean[] = [];
  let failWrite = true;
  setPublicationBroadcastForTesting((event) => {
    if (event.type === "debug-mode-status") recordings.push(event.recording);
  });
  try {
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.manager.executeConversationCommand(fixture.binding.address, {
      kind: "enter",
      logFilePath: "/logs",
      debugSessionId: "failed-recording",
    });
    await vi.waitFor(() => expect(recordings).toEqual([true]));
    setConversationPersistenceAdapterDeps({
      async mutateConversation(p, s, c, label, mutate) {
        if (failWrite) throw new Error("Recording commit refused");
        await fixture.persistence.store.mutateConversation(
          p,
          s,
          c,
          label,
          mutate,
        );
      },
      publishSessionStatus: () => ({ delivered: true }),
      queueAutoName: () => {},
    });
    await expect(
      fixture.manager.executeConversationCommand(fixture.binding.address, {
        kind: "set_recording",
        recording: false,
      }),
    ).rejects.toThrow("Recording commit refused");
    expect(recordings).toEqual([true]);
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.debugMode?.recording,
    ).toBe(true);
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.debugMode?.recording,
    ).toBe(false);
  } finally {
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.close();
    _resetPublicationForTesting();
  }
});

it("acknowledges a turn only after its final row projection commits", async () => {
  const fixture = await createLifecycleFixture();
  const gate = deferred();
  let writing = false;
  let completed = false;
  setConversationPersistenceAdapterDeps({
    async mutateConversation(p, s, c, label, mutate) {
      await fixture.persistence.store.mutateConversation(
        p,
        s,
        c,
        label,
        async (row) => {
          await mutate(row);
          if (
            row.promptCount > 0 &&
            label === "conversation-manager.syncDerived"
          ) {
            writing = true;
            await gate.promise;
          }
        },
      );
    },
    publishSessionStatus: () => ({ delivered: true }),
    queueAutoName: () => {},
  });
  try {
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "Durable result",
      },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    const completion = admission.turn.completed.then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(writing).toBe(true));
    expect(completed).toBe(false);
    gate.resolve();
    expect((await completion).outcome.kind).toBe("call_result");
    const row = await fixture.persistence.store.getConversation(
      fixture.identity.projectPath,
      fixture.identity.sessionName,
      fixture.identity.conversationId,
    );
    expect(row?.promptCount).toBe(1);
    expect(row?.status).toBe("awaiting");
  } finally {
    gate.resolve();
    await fixture.close();
  }
});

it("flushes and awaits the final resume-token snapshot before acknowledgement", async () => {
  const fixture = await createLifecycleFixture();
  const gate = deferred();
  let writing = false;
  let completed = false;
  setPersistenceDeps({
    getConversationMachineSnapshot:
      fixture.persistence.store.getConversationMachineSnapshot,
    deleteConversationMachineSnapshot:
      fixture.persistence.store.deleteConversationMachineSnapshot,
    async upsertConversationMachineSnapshot(owner, id, snapshot) {
      writing = true;
      await gate.promise;
      await fixture.persistence.store.upsertConversationMachineSnapshot(
        owner,
        id,
        snapshot,
      );
    },
  });
  try {
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "Snapshot result",
      },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    const completion = admission.turn.completed.then((result) => {
      completed = true;
      return result;
    });
    await vi.waitFor(() => expect(writing).toBe(true));
    expect(completed).toBe(false);
    gate.resolve();
    await completion;
    expect(
      fixture.persistence.store.getConversationMachineSnapshot(
        "session",
        fixture.identity.conversationId,
      ),
    ).toMatchObject({ context: { promptCount: 1, status: "awaiting" } });
  } finally {
    gate.resolve();
    await fixture.close();
  }
});

it("reports a failed snapshot commit and reconciles the final token without another turn", async () => {
  const fixture = await createLifecycleFixture();
  let failWrite = true;
  setPersistenceDeps({
    getConversationMachineSnapshot:
      fixture.persistence.store.getConversationMachineSnapshot,
    deleteConversationMachineSnapshot:
      fixture.persistence.store.deleteConversationMachineSnapshot,
    async upsertConversationMachineSnapshot(owner, id, snapshot) {
      if (failWrite) throw new Error("Snapshot commit unavailable");
      await fixture.persistence.store.upsertConversationMachineSnapshot(
        owner,
        id,
        snapshot,
      );
    },
  });
  try {
    const admitted = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "task_run",
        executionClass: "nongoverned-task",
        promptText: "Retain token",
      },
    });
    if (admitted.kind !== "accepted") throw new Error(admitted.message);
    expect((await admitted.turn.completed).outcome).toMatchObject({
      kind: "settlement_failed",
      code: "persistence",
    });
    await expect(
      fixture.manager.ensureConversationLifecycle(fixture.binding),
    ).rejects.toThrow("Snapshot commit unavailable");
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    expect(
      fixture.persistence.store.getConversationMachineSnapshot(
        "session",
        fixture.identity.conversationId,
      ),
    ).toMatchObject({ context: { promptCount: 1, status: "awaiting" } });
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.promptCount,
    ).toBe(1);
  } finally {
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.close();
  }
});

it("retains failed finalization, releases resources, and reconciles without replaying accounting or execution", async () => {
  let dispatches = 0;
  let locked = false;
  let failWrite = true;
  const fixture = await createLifecycleFixture({
    actorDeps: {
      acquireConversationLock: () => {
        locked = true;
        return () => {
          locked = false;
        };
      },
      getTaskRunner: () => ({
        backend: "claude",
        async run() {
          dispatches++;
          return {
            text: "Paid once",
            usage: null,
            error: null,
            timedOut: false,
            failure: null,
            continuationDisposition: "retain",
          };
        },
      }),
    },
  });
  setConversationPersistenceAdapterDeps({
    async mutateConversation(p, s, c, label, mutate) {
      await fixture.persistence.store.mutateConversation(
        p,
        s,
        c,
        label,
        async (row) => {
          await mutate(row);
          if (
            failWrite &&
            row.promptCount > 0 &&
            label === "conversation-manager.syncDerived"
          )
            throw new Error("Commit unavailable");
        },
      );
    },
    publishSessionStatus: () => ({ delivered: true }),
    queueAutoName: () => {},
  });
  const submission = {
    binding: fixture.binding,
    turn: {
      kind: "task_run" as const,
      executionClass: "nongoverned-task" as const,
      promptText: "Reconcile",
    },
  };
  try {
    const first = await fixture.manager.submitConversationTurn(submission);
    if (first.kind !== "accepted") throw new Error(first.message);
    expect((await first.turn.completed).outcome).toMatchObject({
      kind: "settlement_failed",
      code: "persistence",
    });
    expect(locked).toBe(false);
    expect(
      await fixture.manager.submitConversationTurn(submission),
    ).toMatchObject({
      kind: "refused",
      code: "busy",
    });
    await expect(
      fixture.manager.ensureConversationLifecycle(fixture.binding),
    ).rejects.toThrow("Commit unavailable");
    expect(dispatches).toBe(1);
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    const row = await fixture.persistence.store.getConversation(
      fixture.identity.projectPath,
      fixture.identity.sessionName,
      fixture.identity.conversationId,
    );
    expect(row?.promptCount).toBe(1);
    expect(dispatches).toBe(1);
  } finally {
    failWrite = false;
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.close();
  }
});

it("acknowledges a recording command after commit and leaves an unchanged selection unwritten", async () => {
  const fixture = await createLifecycleFixture();
  const gate = deferred();
  let writing = false;
  let writes = 0;
  let completed = false;
  try {
    await fixture.manager.ensureConversationLifecycle(fixture.binding);
    await fixture.manager.executeConversationCommand(fixture.binding.address, {
      kind: "enter",
      logFilePath: "/logs",
      debugSessionId: "durable-debug",
    });
    await vi.waitFor(async () =>
      expect(
        (
          await fixture.persistence.store.getConversation(
            fixture.identity.projectPath,
            fixture.identity.sessionName,
            fixture.identity.conversationId,
          )
        )?.debugMode?.active,
      ).toBe(true),
    );
    setConversationPersistenceAdapterDeps({
      async mutateConversation(p, s, c, label, mutate) {
        writes++;
        await fixture.persistence.store.mutateConversation(
          p,
          s,
          c,
          label,
          async (row) => {
            await mutate(row);
            writing = true;
            await gate.promise;
          },
        );
      },
      publishSessionStatus: () => ({ delivered: true }),
      queueAutoName: () => {},
    });
    const command = fixture.manager
      .executeConversationCommand(fixture.binding.address, {
        kind: "set_recording",
        recording: false,
      })
      .then((result) => {
        completed = true;
        return result;
      });
    await vi.waitFor(() => expect(writing).toBe(true));
    expect(completed).toBe(false);
    gate.resolve();
    expect(await command).toEqual({ kind: "applied" });
    expect(
      (
        await fixture.persistence.store.getConversation(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        )
      )?.debugMode?.recording,
    ).toBe(false);
    const before = writes;
    expect(
      await fixture.manager.executeConversationCommand(
        fixture.binding.address,
        {
          kind: "set_recording",
          recording: false,
        },
      ),
    ).toEqual({ kind: "unchanged" });
    expect(writes).toBe(before);
  } finally {
    gate.resolve();
    await fixture.close();
  }
});
