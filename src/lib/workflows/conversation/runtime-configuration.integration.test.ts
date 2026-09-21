import { afterEach, expect, it } from "vitest";
import type {
  ConversationBackendCreateInput,
  ConversationBackendTurnResult,
  ConversationBackendTurnInput,
} from "@/lib/agent-backends/conversation";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { readNextTurnContextLoss } from "./pre-turn/next-turn-context-loss";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";

const result: ConversationBackendTurnResult = {
  backendRef: null,
  costUsd: 0.01,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [{ type: "text", text: "{}" }],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};
let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function configurationFixture(focusPresent = false) {
  const created: ConversationBackendCreateInput[] = [];
  const session = sessionStateSchema.parse({
    sessionName: "s",
    worktreePath: "/lifecycle-fixture/s",
    branchName: "s",
    createdAt: "2026-09-06T00:00:00Z",
    lastActivityAt: "2026-09-06T00:00:00Z",
    creationMode: "normal",
    tddEnabled: false,
  });
  const references: Array<{ filePath: string; description: string }> = [];
  let registrations = 0;
  let closes = 0;
  fixture = await createLifecycleFixture({
    actorDeps: {
      getSessionState: async () => session,
      getReferenceDocuments: async () => references,
      fileExists: (file) =>
        focusPresent && file.endsWith("/memory-bank/focus.md"),
      createReferenceDocument: async (_p, _s, filePath, description) => {
        registrations++;
        if (!references.some((ref) => ref.filePath === filePath))
          references.push({ filePath, description });
        return {};
      },
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async (input) => {
          created.push(input);
          return createMockBackendRuntime({
            close: async () => {
              closes++;
            },
            sendTurn: async (turn) => {
              await turn.onEvent({ type: "input_accepted" });
              return result;
            },
          });
        },
      }),
    },
  });
  const active = fixture;
  return {
    created,
    session,
    references,
    get registrations() {
      return registrations;
    },
    get closes() {
      return closes;
    },
    async turn(turn: {
      promptText: string;
      askUserQuestionsEnabled?: boolean;
      outputFormat?: ConversationBackendTurnInput["outputFormat"];
    }) {
      const execution = await active.manager.executeConversationTurn({
        binding: active.binding,
        turn: { ...turn, structuredOutputTurns: "single" },
      });
      expect(execution.kind).toBe("settled");
      if (execution.kind !== "settled") throw new Error(execution.message);
      expect(execution.turn.outcome.kind).toBe("call_result");
    },
    async preview() {
      return readNextTurnContextLoss(
        {
          findConversation: async () => ({
            projectPath: active.binding.address.projectPath,
            sessionName: "s",
            promptCount: 1,
            hasResumeHandle: false,
            pendingCheckpoint: false,
          }),
          getRuntimeConfiguration:
            active.manager.getConversationRuntimeConfiguration,
          readDesiredRuntimeConfiguration:
            active.manager.readDesiredConversationRuntimeConfiguration,
        },
        "c",
      );
    },
  };
}

it("reuses the runtime across equal, changed, and removed turn schemas", async () => {
  const f = await configurationFixture();
  await f.turn({
    promptText: "first",
    outputFormat: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { answer: { type: "string", description: "Answer" } },
      },
    },
  });
  await f.turn({
    promptText: "second",
    outputFormat: {
      type: "json_schema",
      schema: {
        properties: { answer: { description: "Answer", type: "string" } },
        type: "object",
      },
    },
  });
  expect(f.created).toHaveLength(1);
  await f.turn({
    promptText: "third",
    outputFormat: {
      type: "json_schema",
      schema: { type: "object", properties: { answer: { type: "number" } } },
    },
  });
  await f.turn({ promptText: "fourth" });
  expect(f.created).toHaveLength(1);
  expect(f.closes).toBe(0);
  expect(f.created[0]).not.toHaveProperty("outputFormat");
});

it("refreshes ask policy and keeps its known selection in the at-rest preview", async () => {
  const f = await configurationFixture();
  await f.turn({ promptText: "first" });
  await f.turn({ promptText: "second", askUserQuestionsEnabled: true });
  expect(f.created).toHaveLength(2);
  expect(f.created[0]?.sessionInstructions).not.toEqual(
    f.created[1]?.sessionInstructions,
  );
  expect((await f.preview()).runtimeCreatedWithoutResume).toBe(false);
  await f.turn({ promptText: "third", askUserQuestionsEnabled: true });
  expect(f.created).toHaveLength(2);
});

it.each(["TDD", "reference"] as const)(
  "execution and read-only preview agree when durable %s instructions change",
  async (dimension) => {
    const f = await configurationFixture();
    await f.turn({ promptText: "first" });
    expect((await f.preview()).runtimeCreatedWithoutResume).toBe(false);
    if (dimension === "TDD") f.session.tddEnabled = true;
    else
      f.references.push({
        filePath: "memory-bank/design.md",
        description: "Selected contract",
      });
    expect((await f.preview()).runtimeCreatedWithoutResume).toBe(true);
    const registrations = f.registrations;
    await f.preview();
    expect(f.registrations).toBe(registrations);
    await f.turn({ promptText: "second" });
    expect(f.created).toHaveLength(2);
    expect((await f.preview()).runtimeCreatedWithoutResume).toBe(false);
  },
);

it("registers focus before selecting instructions and does not manufacture another rebuild", async () => {
  const f = await configurationFixture(true);
  await f.turn({ promptText: "first" });
  expect(f.created[0]?.sessionInstructions.join("\n")).toContain(
    "memory-bank/focus.md",
  );
  const registrations = f.registrations;
  expect((await f.preview()).runtimeCreatedWithoutResume).toBe(false);
  expect(f.registrations).toBe(registrations);
  await f.turn({ promptText: "different per-turn context" });
  expect(f.created).toHaveLength(1);
});

it("records the charter actually used even when Stop retires the backend before accounting", async () => {
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<ConversationBackendTurnResult>();
  fixture = await createLifecycleFixture({
    actorDeps: {
      getSessionState: async () =>
        sessionStateSchema.parse({
          sessionName: "s",
          worktreePath: "/lifecycle-fixture/s",
          branchName: "s",
          createdAt: "2026-09-06T00:00:00Z",
          lastActivityAt: "2026-09-06T00:00:00Z",
          creationMode: "normal",
        }),
      getActiveAlignmentInjection: async () => ({
        version: 3,
        text: "Charter used for this turn",
        contentHash: "charter-3",
      }),
      getConversationBackendFactory: () => ({
        backend: "claude",
        validateModelSelection() {},
        createRuntime: async () =>
          createMockBackendRuntime({
            sendTurn: async (input) => {
              await input.onEvent({ type: "input_accepted" });
              started.resolve();
              return finish.promise;
            },
            close: async () => {
              finish.resolve({ ...result, aborted: true });
            },
          }),
      }),
    },
  });
  const admission = await fixture.manager.submitConversationTurn({
    binding: fixture.binding,
    turn: { promptText: "Use charter" },
  });
  if (admission.kind !== "accepted") throw new Error(admission.message);
  await started.promise;
  await admission.turn.cancel("user");
  await admission.turn.completed;
  expect(
    (
      await fixture.persistence.store.getConversation(
        "/lifecycle-fixture",
        "s",
        "c",
      )
    )?.lastSeenAlignmentVersion,
  ).toBe(3);
});
