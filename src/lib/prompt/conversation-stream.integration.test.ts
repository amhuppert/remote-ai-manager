import { expect, it } from "vitest";
import { globalConfigSchema } from "@/lib/config/schemas";
import { createLifecycleFixture } from "@/lib/workflows/conversation/testing/lifecycle-fixture";
import { createMockBackendRuntime } from "@/lib/workflows/conversation/testing/actor-deps-fixture";
import { setConversationPersistenceAdapterDeps } from "@/lib/workflows/conversation/persistence-adapter";
import { createPromptExecutor } from "./sdk-driver";

it.each([false, true])(
  "emits one terminal frame after durable settlement (provider failure: %s)",
  async (failed) => {
    const committing = Promise.withResolvers<void>();
    const commit = Promise.withResolvers<void>();
    const factory = {
      backend: "claude" as const,
      validateModelSelection() {},
      createRuntime: async () =>
        createMockBackendRuntime({
          sendTurn: async (input) => {
            await input.onEvent({ type: "input_accepted" });
            return {
              backendRef: null,
              costUsd: 0.1,
              durationMs: 1,
              numTurns: 1,
              contextTokens: 1,
              contextWindowMax: 200000,
              contentBlocks: [],
              aborted: false,
              compacted: false,
              continuationDisposition: "retain" as const,
              failure: failed
                ? {
                    kind: "backend_error" as const,
                    message: "Provider refused the request",
                    retryable: false,
                  }
                : null,
            };
          },
        }),
    };
    const fixture = await createLifecycleFixture({
      actorDeps: { getConversationBackendFactory: () => factory },
    });
    setConversationPersistenceAdapterDeps({
      mutateConversation: (p, s, c, label, mutate) =>
        fixture.persistence.store.mutateConversation(
          p,
          s,
          c,
          label,
          async (row) => {
            await mutate(row);
            if ((row.totalTurns ?? 0) > 0) {
              committing.resolve();
              await commit.promise;
            }
          },
        ),
      publishSessionStatus: () => ({ delivered: true }),
      queueAutoName: () => {},
    });
    const executor = createPromptExecutor({
      getConversation: fixture.persistence.store.getConversation,
      createConversation: async () => {
        throw new Error("Unexpected conversation creation");
      },
      setConversationBackend: async () => {
        throw new Error("Unexpected backend replacement");
      },
      getProjectDisplayName: () => "lifecycle-fixture",
      readConfig: async () => globalConfigSchema.parse({}),
      getConversationBackendFactory: () => factory,
      submitConversationTurn: fixture.manager.submitConversationTurn,
      dispatchConversationCommand: async () => {
        throw new Error("Unexpected slash command");
      },
    });
    const frames: { event: string; data: unknown }[] = [];
    const execution = executor.executePromptStream(
      "/lifecycle-fixture",
      (await fixture.persistence.store.getSession("/lifecycle-fixture", "s"))!,
      "Stream the result",
      (event, data) => frames.push({ event, data }),
      "c",
    );
    try {
      await committing.promise;
      expect(frames.filter((frame) => frame.event === "done")).toEqual([]);
      commit.resolve();
      await execution;
      expect(frames.filter((frame) => frame.event === "done")).toHaveLength(1);
      expect(frames.filter((frame) => frame.event === "error")).toHaveLength(
        failed ? 1 : 0,
      );
      expect(frames.at(-1)?.event).toBe("done");
      expect(
        await fixture.persistence.store.getConversation(
          "/lifecycle-fixture",
          "s",
          "c",
        ),
      ).toMatchObject({ totalTurns: 1, totalCostUsd: 0.1 });
    } finally {
      commit.resolve();
      await execution;
      await fixture.close();
    }
  },
);
