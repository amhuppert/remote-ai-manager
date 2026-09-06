/**
 * Conversation machine actor stubs.
 *
 * Each actor is a `fromPromise` stub that lazy-imports the production
 * implementation. Override via `.provide()` in tests.
 */

import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "./runtime-state";
import { fromPromise } from "xstate";
import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
} from "./types";

/**
 * Acquire session lock, query slot, and initialize transcript path.
 */
export const prepareTurnActor = fromPromise<
  PrepareTurnOutput,
  PrepareTurnInput
>(async ({ input }) => {
  const { prepareTurnForMachine } = await import("./actor-implementations");
  return prepareTurnForMachine(input);
});

/**
 * Execute a prompt via the Claude Agent SDK.
 * Handles QuerySession reuse, system prompt construction, SDK streaming,
 * transcript writes, and structured output for debug phases.
 */
export const executePromptActor = fromPromise<
  PromptActorResult,
  ExecutePromptInput
>(async ({ input, signal }) => {
  const runtime = getConversationRuntime(
    conversationRuntimeKey(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    ),
  );
  const execution = (async () => {
    const { executePromptForMachine } = await import("./actor-implementations");
    return executePromptForMachine(input, signal);
  })();
  if (runtime)
    runtime.turnCompletion = execution.then(
      () => {},
      () => {},
    );
  return execution;
});

/**
 * Execute a single-shot task run via the shared AgentCall primitive.
 * Non-streaming variant: invokes `executeAgentCall` once, persists one final
 * TranscriptMessage, broadcasts `message-appended` exactly once.
 */
export const runTaskRunActor = fromPromise<PromptActorResult, RunTaskRunInput>(
  async ({ input }) => {
    const { runTaskRunTurnForMachine } =
      await import("./actor-implementations");
    return runTaskRunTurnForMachine(input);
  },
);

export const finalizeQueuedDeliveryActor = fromPromise<
  void,
  import("./types").FinalizeQueuedDeliveryInput
>(async ({ input }) => {
  const { finalizeQueuedDeliveryForMachine } =
    await import("./actor-implementations");
  await finalizeQueuedDeliveryForMachine(input);
});
