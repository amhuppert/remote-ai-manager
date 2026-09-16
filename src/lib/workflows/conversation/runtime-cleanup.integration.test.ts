import { describe, expect, it, vi } from "vitest";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";

describe.each(["session", "project"] as const)(
  "unverified runtime cleanup (%s)",
  (scope) => {
    it("retains the indexed owner and refuses another turn or queue drain even when notification fails", async () => {
      const cleanupFailure = {
        kind: "cleanup_unverified",
        message: "Inspect surviving commands; protection ends at restart.",
      } as const;
      const result: ConversationBackendTurnResult = {
        backendRef: null,
        costUsd: 0.1,
        durationMs: 1,
        numTurns: 1,
        contextTokens: 10,
        contextWindowMax: 200000,
        contentBlocks: [{ type: "text", text: "partial response" }],
        aborted: true,
        compacted: false,
        failure: null,
        continuationDisposition: "retain",
        cleanupFailure,
      };
      const backend = createMockBackendRuntime({
        sendTurn: async (input) => {
          await input.onEvent({ type: "input_accepted" });
          return result;
        },
      });
      const createRuntime = vi.fn(async () => backend);
      const unregister = vi.fn();
      const notify = vi.fn(async () => {
        throw new Error("notification unavailable");
      });
      const claims = vi.fn(async () => null);
      const target =
        scope === "session"
          ? {
              scope,
              projectName: "lifecycle-fixture",
              sessionName: "s",
              conversationId: "c",
            }
          : { scope, projectName: "lifecycle-fixture", conversationId: "c" };
      const fixture = await createLifecycleFixture({
        address: { projectPath: "/lifecycle-fixture", target },
        actorDeps: {
          getSessionState: async () =>
            sessionStateSchema.parse({
              sessionName: "s",
              worktreePath: "/lifecycle-fixture/s",
              branchName: "s",
              createdAt: "2026-09-16T00:00:00Z",
              lastActivityAt: "2026-09-16T00:00:00Z",
              creationMode: "normal",
              tddEnabled: false,
            }),
          getConversationBackendFactory: () => ({
            backend: "claude",
            createRuntime,
            validateModelSelection() {},
          }),
          unregisterBackendRuntime: unregister,
          notifyRuntimeCleanup: notify,
        },
        queue: { claimNextTurnBatch: claims },
      });
      try {
        const first = await fixture.manager.executeConversationTurn({
          binding: fixture.binding,
          turn: { promptText: "run" },
        });
        expect(first).toMatchObject({
          kind: "settled",
          turn: {
            outcome: {
              kind: "call_result",
              result: {
                outcome: {
                  kind: "failed",
                  error: {
                    failureKind: "backend_error",
                    retryable: false,
                    message: cleanupFailure.message,
                  },
                },
              },
            },
          },
        });
        const owner = getConversationRuntime(
          conversationRuntimeKey(
            fixture.identity.projectPath,
            fixture.identity.sessionName,
            fixture.identity.conversationId,
          ),
        )?.managed;
        expect(owner?.cleanupFailure).toEqual(cleanupFailure);
        await owner?.settleOwnedWork();
        expect(notify).toHaveBeenCalledTimes(1);
        const next = await fixture.manager.submitConversationTurn({
          binding: fixture.binding,
          turn: { promptText: "must not dispatch" },
        });
        expect(next).toMatchObject({
          kind: "refused",
          code: "busy",
          message: cleanupFailure.message,
        });
        claims.mockClear();
        await fixture.manager.ensureConversationActorAndDrain(
          fixture.identity.projectPath,
          fixture.identity.sessionName,
          fixture.identity.conversationId,
        );
        expect(claims).not.toHaveBeenCalled();
        expect(createRuntime).toHaveBeenCalledTimes(1);
        expect(unregister).not.toHaveBeenCalled();
        expect(owner?.backend).toBe(backend);
      } finally {
        // The hold deliberately lasts for this process; a fixture restart drops it.
        fixture.restart();
        await fixture.close();
      }
    });
  },
);
