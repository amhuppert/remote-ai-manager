import { afterEach, expect, it, vi } from "vitest";
import type { ConversationBackendTurnResult } from "@/lib/agent-backends/conversation";
import { askQuestionItemSchema } from "@/lib/conversations/schemas";
import { createMockBackendRuntime } from "./testing/actor-deps-fixture";
import { createLifecycleFixture } from "./testing/lifecycle-fixture";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";

const waitingText =
  "I have asked which contract applies and am waiting for input.";
const backendResult: ConversationBackendTurnResult = {
  backendRef: null,
  costUsd: 0,
  durationMs: 1,
  numTurns: 1,
  contextTokens: 1,
  contextWindowMax: 200000,
  contentBlocks: [{ type: "text", text: waitingText }],
  aborted: false,
  compacted: false,
  failure: null,
  continuationDisposition: "retain",
};

let fixture: Awaited<ReturnType<typeof createLifecycleFixture>> | undefined;
let finish: ReturnType<typeof Promise.withResolvers<void>>;

afterEach(async () => {
  finish?.resolve();
  await fixture?.close();
  fixture = undefined;
});

it.each(["claude", "codex", "cursor"] as const)(
  "%s preserves an asking validator's work turn without a structured-output repair",
  async (backend) => {
    finish = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const prompts: string[] = [];
    const close = vi.fn(async () => {});
    fixture = await createLifecycleFixture({
      conversation: { role: "validator", agentBackend: backend },
      actorDeps: {
        getConversationBackendFactory: () => ({
          backend,
          validateModelSelection() {},
          createRuntime: async (input) =>
            createMockBackendRuntime({
              backend,
              modelSelection: input.modelSelection,
              close,
              sendTurn: async (turn) => {
                prompts.push(turn.promptText);
                await turn.onEvent({ type: "input_accepted" });
                started.resolve();
                await finish.promise;
                return backendResult;
              },
            }),
        }),
      },
    });
    const admission = await fixture.manager.submitConversationTurn({
      binding: fixture.binding,
      turn: {
        kind: "conversation_turn",
        backend,
        promptText: "Review the contract",
        askUserQuestionsEnabled: true,
        outputFormat: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: { verdict: { type: "string" } },
            required: ["verdict"],
          },
        },
      },
    });
    if (admission.kind !== "accepted") throw new Error(admission.message);
    await started.promise;
    expect(
      await fixture.manager.registerConversationQuestion(
        "/lifecycle-fixture",
        "s",
        "c",
        {
          questionId: "validator-question",
          questions: [
            askQuestionItemSchema.parse({
              id: "contract",
              question: "Which contract applies?",
              options: [{ label: "Current" }, { label: "Proposed" }],
            }),
          ],
        },
      ),
    ).toBe(true);
    finish.resolve();
    const settled = await admission.turn.completed;

    expect(prompts).toHaveLength(1);
    expect(settled).toMatchObject({
      status: "waiting_for_input",
      pendingQuestion: { questionId: "validator-question" },
      outcome: {
        kind: "call_result",
        result: { outcome: { kind: "completed", text: waitingText } },
      },
    });
    expect(
      await fixture.persistence
        .recreateStore()
        .getConversation("/lifecycle-fixture", "s", "c"),
    ).toMatchObject({
      status: "waiting_for_input",
      pendingQuestionId: "validator-question",
    });

    await fixture.manager.stopConversationActor(
      "/lifecycle-fixture",
      "s",
      "c",
      "workflow_turn_completed",
    );
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      getConversationRuntime(
        conversationRuntimeKey("/lifecycle-fixture", "s", "c"),
      ),
    ).toBeUndefined();
    expect(
      await fixture.persistence
        .recreateStore()
        .getConversation("/lifecycle-fixture", "s", "c"),
    ).toMatchObject({
      status: "waiting_for_input",
      pendingQuestionId: "validator-question",
    });
  },
);
