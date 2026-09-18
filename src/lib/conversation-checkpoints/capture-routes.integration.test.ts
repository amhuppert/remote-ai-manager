import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createCheckpointRouteHandlers } from "./route-handlers";
import {
  createCheckpointHarness,
  capturedHandoffResult,
  deferred,
} from "@/lib/workflows/conversation/testing/checkpoint-harness";
import type { ConversationCheckpointStart } from "@/lib/workflows/conversation/manager";

function compose(h: Awaited<ReturnType<typeof createCheckpointHarness>>) {
  const { identity, manager } = h.fixture;
  const target = h.fixture.binding.address.target;
  const completions: Promise<unknown>[] = [];
  const handlers = createCheckpointRouteHandlers({
    resolveProjectPath: async (name) =>
      name === target.projectName ? identity.projectPath : null,
    getSession: async (path, session) =>
      target.scope === "session" &&
      path === identity.projectPath &&
      session === identity.sessionName
        ? { conversations: [await h.readRow()] }
        : null,
    getProjectConversation: async (path, id) =>
      target.scope === "project" &&
      path === identity.projectPath &&
      id === identity.conversationId
        ? h.readRow()
        : null,
    repo: async () => h.fixture.checkpoints,
    startCheckpoint: async (input): Promise<ConversationCheckpointStart> => {
      const result = await manager.startConversationCheckpoint(input);
      if (result.kind !== "refused") completions.push(result.completion);
      return result;
    },
    checkCheckpoint: manager.checkConversationCheckpoint,
    cancelCheckpoint: manager.cancelConversationCheckpoint,
    reconcileCheckpoint: manager.reconcileConversationCheckpoint,
    skipHandoff: manager.skipConversationCheckpointHandoff,
    auth: {
      requireToken: async () => null,
      validateOptionalToken: async () => ({ kind: "absent" }),
    },
  });
  const params: Record<string, string> = {
    name: target.projectName,
    conversationId: identity.conversationId,
    ...(target.scope === "session" ? { session: identity.sessionName } : {}),
  };
  const scope = target.scope;
  const start =
    scope === "session" ? handlers.sessionStart : handlers.projectStart;
  const skip =
    scope === "session"
      ? handlers.sessionSkipHandoff
      : handlers.projectSkipHandoff;
  const check =
    scope === "session"
      ? handlers.sessionEligibility
      : handlers.projectEligibility;
  const request = (body?: unknown) =>
    new Request(
      "http://checkpoint.test/checkpoints",
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) },
    );
  const context = (extra: Record<string, string> = {}) => ({
    params: Promise.resolve({ ...params, ...extra }),
  });
  return { handlers, start, skip, check, request, context, completions };
}

describe.each(["session", "project"] as const)(
  "capture HTTP manager composition (%s)",
  (scope) => {
    it("checks without allocation or writes and returns durable admission and skip before capture cleanup", async () => {
      const entered = deferred();
      const finish = deferred();
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => {
          entered.resolve();
          await finish.promise;
          return capturedHandoffResult(h.seededRef);
        },
      });
      const c = compose(h);
      const requestId = randomUUID();
      try {
        const before = await h.readRow();
        const checked = await c.check(c.request(), c.context());
        expect(checked.status).toBe(200);
        expect(await checked.json()).toMatchObject({
          eligible: true,
          handoff: { available: true, mode: "tool-disabled" },
        });
        expect(await h.readRow()).toEqual(before);
        expect(h.state.created).toEqual([]);
        expect(
          await h.fixture.checkpoints.getStateForAdmission(h.scopeKey),
        ).toMatchObject({ active: null });
        const started = await c.start(
          c.request({ requestId, handoff: { mode: "tool-disabled" } }),
          c.context(),
        );
        expect(started.status).toBe(202);
        expect(await h.operation(requestId)).toMatchObject({
          phase: "building",
          handoff: { requestedMode: "tool-disabled" },
        });
        await entered.promise;
        const wrong = await c.skip(
          c.request({}),
          c.context({ checkpointId: randomUUID() }),
        );
        expect(wrong.status).toBe(404);
        const beforeWrongScope = await h.operation(requestId);
        const wrongScope = await c.skip(
          c.request({}),
          c.context({ checkpointId: requestId, name: "neighbor" }),
        );
        expect(wrongScope.status).toBe(404);
        const otherScope =
          scope === "session"
            ? c.handlers.projectSkipHandoff
            : c.handlers.sessionSkipHandoff;
        const crossed = await otherScope(
          c.request({}),
          c.context({ checkpointId: requestId, session: "neighbor" }),
        );
        expect(crossed.status).toBe(404);
        expect(await h.operation(requestId)).toEqual(beforeWrongScope);
        const skipped = await c.skip(
          c.request({}),
          c.context({ checkpointId: requestId }),
        );
        expect(skipped.status).toBe(200);
        expect(await skipped.json()).toMatchObject({
          outcome: "stopping",
          receipt: {
            phase: "building",
            handoff: { stage: "settling", stopIntent: "skip" },
          },
        });
        expect(await h.operation(requestId)).toMatchObject({
          phase: "building",
          handoff: { executionSettled: false },
        });
        finish.resolve();
        await Promise.all(c.completions);
        expect(await h.operation(requestId)).toMatchObject({
          phase: "ready",
          handoff: { stage: "omitted", omissionReason: "skipped" },
        });
        const frozen = await c.skip(
          c.request({}),
          c.context({ checkpointId: requestId }),
        );
        expect(await frozen.json()).toMatchObject({
          outcome: "handoff_already_settled",
          receipt: { phase: "ready" },
        });
      } finally {
        finish.resolve();
        await Promise.all(c.completions);
        await h.close();
      }
    });

    it("persists stopped-execution testimony through HTTP while retaining the recovery gate and queue", async () => {
      const h = await createCheckpointHarness({
        scope,
        captureHandoff: async () => ({
          ...capturedHandoffResult(h.seededRef),
          candidateText: null,
          executionSettled: false,
          omissionReason: "cleanup_unverified",
          cleanupFailure: {
            code: "cleanup_unverified",
            message: "child execution unknown",
          },
        }),
      });
      const c = compose(h);
      const requestId = randomUUID();
      try {
        expect(
          (
            await c.start(
              c.request({ requestId, handoff: { mode: "tool-disabled" } }),
              c.context(),
            )
          ).status,
        ).toBe(202);
        await Promise.all(c.completions);
        expect(await h.operation(requestId)).toMatchObject({
          phase: "needs_reconciliation",
        });
        const queued = await h.enqueue("held for explicit recovery");
        h.fixture.restart();
        const restarted = compose(h);
        const reconcile =
          scope === "session"
            ? restarted.handlers.sessionReconcile
            : restarted.handlers.projectReconcile;
        const body = { captureExecutionStopped: true, source: "cli" };
        const wrong = await reconcile(
          restarted.request(body),
          restarted.context({ checkpointId: requestId, name: "neighbor" }),
        );
        expect(wrong.status).toBe(404);
        expect(
          (await h.operation(requestId))?.handoff?.executionStopAttestation,
        ).toBeNull();
        const response = await reconcile(
          restarted.request(body),
          restarted.context({ checkpointId: requestId }),
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: "recovery_required",
        });
        expect(await h.operation(requestId)).toMatchObject({
          phase: "needs_reconciliation",
          handoff: {
            executionSettled: true,
            executionStopAttestation: { source: "cli" },
            continuationDisposition: "clear",
          },
        });
        expect((await h.readRow()).backendRef).toBeNull();
        expect((await h.readRow()).pendingQueue).toMatchObject([
          { id: queued.id, status: "pending" },
        ]);
        expect(h.state.dispatches).toEqual([]);
        expect(h.state.laneCalls).toEqual([]);
      } finally {
        await Promise.all(c.completions);
        await h.close();
      }
    });

    it.each(["null", "stale", "unavailable", "absent", "false"] as const)(
      "admits %s capture as a baseline outcome",
      async (scenario) => {
        let submissions = 0;
        const h = await createCheckpointHarness({
          scope,
          captureHandoff: async () => {
            submissions++;
            return capturedHandoffResult(h.seededRef);
          },
          ...(scenario === "unavailable"
            ? {
                captureAvailability: () => ({
                  available: false as const,
                  mode: null,
                  reason: "unsupported",
                }),
              }
            : {}),
        });
        const c = compose(h);
        const requestId = randomUUID();
        try {
          const mode =
            scenario === "null"
              ? null
              : scenario === "stale"
                ? "instruction-only"
                : "tool-disabled";
          const handoffOption =
            scenario === "absent"
              ? {}
              : scenario === "false"
                ? { handoff: false }
                : { handoff: { mode } };
          const response = await c.start(
            c.request({ requestId, ...handoffOption }),
            c.context(),
          );
          expect(response.status).toBe(202);
          await Promise.all(c.completions);
          expect(await h.operation(requestId)).toMatchObject({
            phase: "ready",
            handoff:
              scenario === "absent" || scenario === "false"
                ? null
                : {
                    requestedMode: mode,
                    stage: "omitted",
                    modeEstablished: false,
                  },
          });
          expect(submissions).toBe(0);
        } finally {
          await Promise.all(c.completions);
          await h.close();
        }
      },
    );
  },
);
