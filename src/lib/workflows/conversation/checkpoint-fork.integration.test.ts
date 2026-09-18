import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { CaptureHandoffResult } from "@/lib/agent-backends/conversation";
import { createCheckpointRouteHandlers } from "@/lib/conversation-checkpoints/route-handlers";
import { createCheckpointForkService } from "@/lib/conversation-checkpoints/fork-service";
import { checkpointForkFraming } from "@/lib/conversation-checkpoints/fork-framing";
import { assertCheckpointForkBackend } from "@/lib/conversation-checkpoints/fork-submission";
import preHandoffV1 from "@/lib/conversation-checkpoints/testing/pre-handoff-v1-payload.json";
import { checkpointPayloadSchema } from "@/lib/conversation-checkpoints/schemas";
import { NO_OP_SNAPSHOT_FIXTURE } from "@/lib/conversations/testing/profile-snapshot-fixtures";
import {
  createCheckpointHarness,
  capturedHandoffResult,
  type CheckpointHarness,
} from "./testing/checkpoint-harness";

let harness: CheckpointHarness | undefined;
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

type SeedFixture = "current" | "pre-handoff-v1" | "included" | "omitted";

async function fork(
  scope: "session" | "project",
  backend: "claude" | "codex",
  seedFixture: SeedFixture = "current",
) {
  let captureAvailable = true;
  const h = (harness = await createCheckpointHarness({
    scope,
    ...(seedFixture === "omitted"
      ? { workingStateObjectiveText: "E".repeat(16000) }
      : {}),
    captureAvailability: () =>
      captureAvailable
        ? { available: true, mode: "tool-disabled" }
        : { available: false, mode: null, reason: "unsupported" },
    captureHandoff: async (): Promise<CaptureHandoffResult> => {
      if (!captureAvailable)
        throw new Error("Destination capture is unsupported");
      return {
        ...capturedHandoffResult(h.seededRef),
        candidateText: JSON.stringify({
          plan:
            seedFixture === "omitted"
              ? Array.from({ length: 3 }, () => ({
                  kind: "belief",
                  text: "H".repeat(1500),
                  sourceRefs: [],
                }))
              : [
                  {
                    kind: "belief",
                    text: "Check the original evidence before acting",
                    sourceRefs: [],
                  },
                ],
          hypotheses: [],
          failedApproaches: [],
          blockers: [],
          nextStep: [],
        }),
      };
    },
  }));
  const ready = await (async () => {
    if (seedFixture === "pre-handoff-v1") {
      const payload = checkpointPayloadSchema.parse(preHandoffV1);
      const repo = h.fixture.checkpoints;
      const admitted = await repo.admitOperation({
        key: h.scopeKey,
        requestId: payload.id,
        sourceBasis: payload.sourceBasis,
        priorBackendRef: h.seededRef?.ref ?? null,
        requestedAt: payload.createdAt,
      });
      if (!admitted.ok) throw new Error(admitted.refusal.code);
      const frozen = await repo.freezePayload({
        key: h.scopeKey,
        operationId: payload.id,
        payload,
        at: payload.createdAt,
      });
      if (!frozen.ok) throw new Error(frozen.refusal.code);
      const result = await repo.commitReady({
        key: h.scopeKey,
        operationId: payload.id,
        at: payload.createdAt,
      });
      if (!result.ok) throw new Error(result.refusal.code);
      h.fixture.restart();
      expect(await repo.getPayload(h.scopeKey, payload.id)).toEqual(
        preHandoffV1,
      );
      await h.runOrdinaryTurn("consume historical checkpoint");
      expect(h.state.dispatches).toEqual([
        `${payload.seedText}\n\nconsume historical checkpoint`,
      ]);
      expect(await h.operation(payload.id)).toMatchObject({
        phase: "applied",
        handoff: null,
        acceptance: { seedHash: payload.seedSha256 },
      });
      h.state.dispatches.length = 0;
      h.state.turnInputs.length = 0;
      return result.value;
    }
    if (seedFixture === "current") return h.checkpointToReady();
    const admitted = h.admittedOr(
      await h.fixture.manager.startConversationCheckpoint({
        address: h.fixture.binding.address,
        requestId: randomUUID(),
        handoff: { mode: "tool-disabled" },
      }),
    );
    const result = await admitted.completion;
    expect(result).toMatchObject({
      phase: "ready",
      handoff: {
        stage: seedFixture,
        omissionReason: seedFixture === "omitted" ? "seed_budget" : null,
      },
    });
    return result;
  })();
  captureAvailable = false;
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
  return {
    h,
    ready,
    created,
    sourceBefore,
    key,
    payload,
    submit,
    row,
    selection,
  };
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

// Frozen from the independently authored pre-feature fixture in
// 42946e4cc:src/lib/conversation-checkpoints/fork-repo.test.ts (2026-09-12).
// This literal envelope must not be regenerated with the current builder.
describe.each(["session", "project"] as const)(
  "%s saved seed compatibility",
  (scope) => {
    it.each([
      ["pre-handoff-v1", "claude"],
      ["pre-handoff-v1", "codex"],
      ["included", "claude"],
      ["included", "codex"],
      ["omitted", "claude"],
      ["omitted", "codex"],
    ] as const)(
      "delivers and forks %s unchanged to %s without destination capture support",
      async (variant, backend) => {
        const f = await fork(scope, backend, variant);
        const operationBefore = await f.h.operation(f.ready.id);
        const original = await f.h.fixture.checkpoints.getPayload(
          f.h.scopeKey,
          f.ready.id,
        );
        if (!original) throw new Error("source payload missing");
        const unexpectedMutation = async () => {
          throw new Error("Reading must not mutate or call a provider");
        };
        const handlers = createCheckpointRouteHandlers({
          resolveProjectPath: async () => f.h.scopeKey.projectPath,
          getSession: f.h.fixture.persistence.store.getSession,
          getProjectConversation:
            f.h.fixture.persistence.store.getProjectConversation,
          repo: async () => f.h.fixture.checkpoints,
          startCheckpoint: unexpectedMutation,
          checkCheckpoint: unexpectedMutation,
          cancelCheckpoint: unexpectedMutation,
          skipHandoff: unexpectedMutation,
          reconcileCheckpoint: unexpectedMutation,
          auth: {
            requireToken: async () => null,
            validateOptionalToken: async () => ({ kind: "absent" }),
          },
        });
        const handler =
          scope === "session" ? handlers.sessionGet : handlers.projectGet;
        const response = await handler(
          new Request("http://localhost/checkpoint?detail=seed"),
          {
            params: Promise.resolve({
              name: f.h.fixture.binding.address.target.projectName,
              session: f.h.fixture.identity.sessionName,
              conversationId: f.h.scopeKey.conversationId,
              checkpointId: f.ready.id,
            }),
          },
        );
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ seed: original });
        expect(f.h.state.dispatches).toEqual([]);
        expect(
          createHash("sha256").update(original.seedText).digest("hex"),
        ).toBe(original.seedSha256);
        expect(f.payload).toEqual({ ...original, id: f.created.operation.id });
        const origin = f.row().checkpointFork;
        if (!origin) throw new Error("fork lineage missing");
        expect(origin).toMatchObject({
          sourceOperationId: f.ready.id,
          seedSha256: original.seedSha256,
          capturedThroughSeq: original.sourceBasis.capturedThroughSeq,
          evidenceSource: f.h.fixture.binding.address.target,
        });
        const admission = await f.submit("use the saved evidence");
        if (admission.kind !== "accepted") throw new Error(admission.message);
        await admission.turn.completed;
        expect(f.h.state.dispatches).toEqual([
          `${checkpointForkFraming(f.row().id, origin)}${original.seedText}\n\nuse the saved evidence`,
        ]);
        expect(
          await f.h.fixture.checkpoints.getOperation(
            f.key,
            f.created.operation.id,
          ),
        ).toMatchObject({
          phase: "applied",
          acceptance: { seedHash: original.seedSha256 },
        });
        f.h.fixture.restart();
        expect(
          await f.h.fixture.checkpoints.getPayload(f.h.scopeKey, f.ready.id),
        ).toEqual(original);
        expect(
          await f.h.fixture.checkpoints.getPayload(
            f.key,
            f.created.operation.id,
          ),
        ).toEqual(f.payload);
        expect(await f.h.readRow()).toEqual(f.sourceBefore);
        expect(await f.h.operation(f.ready.id)).toEqual(operationBefore);
      },
    );
  },
);
