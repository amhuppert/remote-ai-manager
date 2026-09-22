import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { conversationRuntimeKey } from "./runtime-state";
import { fromPromise } from "xstate";
import type {
  PrepareTurnInput,
  PrepareTurnOutput,
  ExecutePromptInput,
  PromptActorResult,
  RunTaskRunInput,
  ConversationContext,
  SettleTurnInput,
} from "./types";
import type { ConversationMachineDependencies } from "./actor-host";
import type { ConversationPersistenceAdapter } from "./persistence-adapter";

export const prepareTurnActor = fromPromise<
  PrepareTurnOutput,
  PrepareTurnInput
>(() => {
  throw new Error("Conversation prepare actor is not configured");
});
export const executePromptActor = fromPromise<
  PromptActorResult,
  ExecutePromptInput
>(() => {
  throw new Error("Conversation execution actor is not configured");
});
export const runTaskRunActor = fromPromise<PromptActorResult, RunTaskRunInput>(
  () => {
    throw new Error("Conversation task actor is not configured");
  },
);
export const settleTurnActor = fromPromise<
  PromptActorResult | null,
  SettleTurnInput
>(() => {
  throw new Error("Conversation settlement actor is not configured");
});

export function createConversationActors(
  deps: ConversationMachineDependencies,
  adapter: ConversationPersistenceAdapter,
) {
  /**
   * Acquire session lock, query slot, and initialize transcript path.
   */
  const prepareTurnActor = fromPromise<PrepareTurnOutput, PrepareTurnInput>(
    async ({ input, signal }) => {
      const runtime = deps.getRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
      );
      const run = async () => {
        const { prepareTurnForMachine } = await deps.loadActors(input);
        return prepareTurnForMachine(
          input,
          runtime?.attempt?.controller.signal ?? signal,
        );
      };
      return runtime?.attempt ? runtime.attempt.track(run, signal) : run();
    },
  );

  /**
   * Execute a prompt via the Claude Agent SDK.
   * Handles QuerySession reuse, system prompt construction, SDK streaming,
   * transcript writes, and structured output for debug phases.
   */
  const executePromptActor = fromPromise<PromptActorResult, ExecutePromptInput>(
    async ({ input, signal }) => {
      const runtime = deps.getRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
      );
      const attempt = runtime?.attempt;
      const run = async () => {
        const { executePromptForMachine } = await deps.loadActors(input);
        const result = await executePromptForMachine(
          input,
          attempt?.controller.signal ?? signal,
        );
        if (attempt) attempt.projectedResult = result;
        return result;
      };
      return attempt ? attempt.track(run, signal) : run();
    },
  );

  /**
   * Execute a single-shot task run via the shared AgentCall primitive.
   * Non-streaming variant: invokes `executeAgentCall` once, persists one final
   * TranscriptMessage, broadcasts `message-appended` exactly once.
   */
  const runTaskRunActor = fromPromise<PromptActorResult, RunTaskRunInput>(
    async ({ input, signal }) => {
      const runtime = deps.getRuntime(
        conversationRuntimeKey(
          input.projectPath,
          conversationTargetStoreSessionName(input.target),
          input.target.conversationId,
        ),
      );
      const attempt = runtime?.attempt;
      const run = async () => {
        const { runTaskRunTurnForMachine } = await deps.loadActors(input);
        const result = await runTaskRunTurnForMachine(
          input,
          attempt?.controller.signal ?? signal,
        );
        if (attempt) attempt.projectedResult = result;
        return result;
      };
      return attempt ? attempt.track(run, signal) : run();
    },
  );

  const settleTurnActor = fromPromise<
    PromptActorResult | null,
    SettleTurnInput
  >(async ({ input }) => {
    const runtime = deps.getRuntime(
      conversationRuntimeKey(
        input.projectPath,
        conversationTargetStoreSessionName(input.target),
        input.target.conversationId,
      ),
    );
    const attempt = runtime?.attempt;
    const finishQueue = async () => {
      if (!input.queuedDelivery) return;
      const { finalizeQueuedDeliveryForMachine } = await deps.loadActors(input);
      await finalizeQueuedDeliveryForMachine({
        ...input,
        queuedDelivery: input.queuedDelivery,
      });
    };
    if (!attempt) {
      await finishQueue();
      return null;
    }
    attempt.ownReceipt(finishQueue);
    await attempt.settle();
    return attempt.projectedResult ?? null;
  });

  function completeTurnForMachine(context: ConversationContext): void {
    const runtime = deps.getRuntime(
      conversationRuntimeKey(
        context.projectPath,
        conversationTargetStoreSessionName(context.target),
        context.target.conversationId,
      ),
    );
    const attempt = runtime?.attempt;
    if (!runtime || !attempt?.isCurrent()) return;
    void Promise.resolve().then(async () => {
      try {
        await adapter.whenDurable(context);
      } catch (error) {
        runtime.durabilityFailure = { context, error };
        attempt.failSettlement("persistence", error);
      }
      if (attempt.hasUnreconciledWork) {
        runtime.durabilityFailure = {
          context,
          error: runtime.durabilityFailure?.error ?? attempt.settlementError,
          attempt,
        };
      }
      attempt.complete(context);
      if (runtime.attempt !== attempt) return;
      runtime.streamEmit = undefined;
      runtime.attempt = undefined;
    });
  }
  return {
    actors: {
      prepareTurn: prepareTurnActor,
      executePrompt: executePromptActor,
      runTaskRun: runTaskRunActor,
      settleTurn: settleTurnActor,
    },
    completeTurn: completeTurnForMachine,
  };
}
