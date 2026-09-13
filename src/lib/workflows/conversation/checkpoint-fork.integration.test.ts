import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createCheckpointForkService } from "@/lib/conversation-checkpoints/fork-service";
import { checkpointForkFraming } from "@/lib/conversation-checkpoints/fork-framing";
import { assertCheckpointForkBackend } from "@/lib/conversation-checkpoints/fork-submission";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import {
  createCheckpointHarness,
  type CheckpointHarness,
} from "./testing/checkpoint-harness";

let harness: CheckpointHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

async function fork(scope: "session" | "project", backend: "claude" | "codex") {
  const h = (harness = await createCheckpointHarness({ scope }));
  const ready = await h.checkpointToReady();
  const sourceBefore = await h.readRow();
  const service = createCheckpointForkService({
    repo: () => h.fixture.checkpoints,
    load: async (_path, target) =>
      h.fixture.persistence.store.checkpointContinuation.find({
        ...h.scopeKey,
        conversationId: target.conversationId,
      }),
    admit: async (_path, _backend, selection) => selection,
    resolveWork: async () => {},
    profile: async () => NO_OP_SNAPSHOT_FIXTURE,
    publish: () => {},
    now: () => new Date().toISOString(),
  });
  const created = await service.create({
    projectPath: h.scopeKey.projectPath,
    source: h.fixture.binding.address.target,
    operationId: ready.id,
    request: {
      requestId: randomUUID(),
      name: "Next phase",
      task: "focused draft",
      relatedWork: { kind: "ticket", ticketNumber: 131 },
      backend: "claude",
      modelSelection: { modelId: "claude-opus-5", parameters: {} },
    },
  });
  const target = {
    ...h.fixture.binding.address.target,
    conversationId: created.conversation.id,
  };
  const address = { ...h.fixture.binding.address, target };
  const key = { ...h.scopeKey, conversationId: target.conversationId };
  const payload = (await h.fixture.checkpoints.getPayload(
    key,
    created.operation.id,
  ))!;
  await h.fixture.persistence.store.mutateConversation(
    h.fixture.identity.projectPath,
    h.fixture.identity.sessionName,
    target.conversationId,
    "select-backend",
    (row) => {
      assertCheckpointForkBackend(row, backend);
      row.agentBackend = backend;
    },
  );
  h.fixture.restart();
  const selection = {
    modelId: backend === "codex" ? "gpt-6-astra" : "claude-opus-5",
    parameters: {},
  };
  const submit = (promptText: string) =>
    h.fixture.manager.submitConversationTurn({
      binding: { kind: "durable", address },
      turn: { promptText, backend, modelSelection: selection },
    });
  const row = () =>
    h.fixture.persistence.recreateStore().checkpointContinuation.find(key)!;
  return { h, created, sourceBefore, key, payload, submit, row, selection };
}

describe.each(["session", "project"] as const)(
  "%s checkpoint fork delivery",
  (scope) => {
    it.each(["claude", "codex"] as const)(
      "dispatches on the edited %s backend after restart, accepts the exact seed once, and leaves source continuity intact",
      async (backend) => {
        const f = await fork(scope, backend);
        expect(f.h.state.dispatches).toHaveLength(0);
        expect(f.row()).toMatchObject({
          promptCount: 0,
          backendRef: null,
          pendingPromptText: "focused draft",
          checkpointFork: { initialSelection: { backend: "claude" } },
        });
        const admission = await f.submit("edited task");
        expect(admission.kind).toBe("accepted");
        if (admission.kind !== "accepted") throw new Error(admission.message);
        await admission.turn.completed;
        const runtime = f.h.latestRuntime();
        expect(runtime.ref.backend).toBe(backend);
        expect(runtime.input.persistedRef).toBeNull();
        expect(runtime.input.modelSelection).toEqual(f.selection);
        expect(f.h.state.dispatches).toEqual([
          `${checkpointForkFraming(f.row().id, f.row().checkpointFork!)}${f.payload.seedText}\n\nedited task`,
        ]);
        expect(f.h.state.turnInputs[0]?.syntheticForkSeed ?? null).toBeNull();
        expect(
          await f.h.fixture.checkpoints.getOperation(
            f.key,
            f.created.operation.id,
          ),
        ).toMatchObject({
          phase: "applied",
          acceptance: { seedHash: f.payload.seedSha256 },
          protectedReferences: {
            priorBackendRef: null,
            acceptedBackendRef: runtime.ref.ref,
          },
        });
        expect(f.row()).toMatchObject({
          agentBackend: backend,
          promptCount: 1,
          backendRef: runtime.ref,
          checkpointFork: { submission: { backend } },
        });
        expect(await f.h.readRow()).toEqual(f.sourceBefore);
        const second = await f.submit("continue");
        if (second.kind !== "accepted") throw new Error(second.message);
        await second.turn.completed;
        expect(f.h.state.dispatches.at(-1)).toBe("continue");
      },
    );

    it("holds uncertain first delivery across restart and refuses backend retargeting or automatic replay", async () => {
      const f = await fork(scope, "codex");
      f.h.state.emitTurnEvents = async () => {};
      f.h.state.nextTurnResult = { backendRef: null };
      const admission = await f.submit("one uncertain task");
      if (admission.kind !== "accepted") throw new Error(admission.message);
      await admission.turn.completed;
      expect(
        await f.h.fixture.checkpoints.getOperation(
          f.key,
          f.created.operation.id,
        ),
      ).toMatchObject({ phase: "needs_reconciliation", acceptance: null });
      f.h.fixture.restart();
      expect(() => assertCheckpointForkBackend(f.row(), "claude")).toThrow(
        "first submission",
      );
      expect((await f.submit("do not replay")).kind).toBe("refused");
      expect(f.h.state.dispatches).toHaveLength(1);
      expect(await f.h.readRow()).toEqual(f.sourceBefore);
    });
  },
);
