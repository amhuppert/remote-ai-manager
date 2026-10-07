import { appendLiveReferenceSummaries } from "@/lib/live-references/service";
import { buildDebugPromptContext } from "@/lib/workflows/debug/prompt-policy";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { expandNativeSpecCommandForAgent } from "@/lib/conversation-commands/native-spec";
import { getDebugManifestPath } from "@/lib/debug-log/service";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationTurnDependencies } from "@/lib/conversation-core/turn/dependencies";
import type { ConversationExecutionContext } from "@/lib/conversation-core/turn/turn-spec";
import { assembleTurnPrompt, type TurnContextExecution } from "@/lib/conversation-core/turn/turn-context";
import { prepareNotepadContext } from "@/lib/conversation-core/contributions/notepad-context";
import { prepareMemoryContext } from "@/lib/conversation-core/contributions/memory-context";
import {
  preparePassiveSubscriptionContext,
  prepareAcceptedNotepadReferences,
} from "@/lib/conversation-core/contributions/passive-subscription-context";
import { createRequiredInputReceipt } from "@/lib/conversation-core/contributions/required-input-receipt";
import { acknowledgeSyntheticForkSeed } from "@/lib/conversation-checkpoints/fork-seed";
import type { ContinuationSeed } from "@/lib/conversation-checkpoints/continuation-seed";
import type { PreparedCheckpointSeed } from "@/lib/conversation-checkpoints/checkpoint-seed";

type TurnContextDependencies = Pick<
  ConversationTurnDependencies,
  "context" | "effects" | "log" | "subscriptions"
> & {
  transcript: Pick<
    ConversationTurnDependencies["transcript"],
    "readConversationMessages"
  >;
  debug: Pick<ConversationTurnDependencies["debug"], "getDebugLogUrl">;
};

export async function prepareConversationTurnContext(
  deps: TurnContextDependencies,
  input: {
    execution: TurnContextExecution;
    promptText: string;
    /** The one continuation this turn runs under; see `resolveContinuationSeed`. */
    continuation: ContinuationSeed;
    /**
     * The ready checkpoint this turn delivers, when `continuation` is one.
     * Prepared by the caller before any runtime exists and settled through
     * the attempt's own receipts, so this step only places its block and
     * routes the turn's events to it.
     */
    checkpoint: PreparedCheckpointSeed | null;
    workflowContext: ConversationExecutionContext["workflowContext"];
    runtimeCreatedWithoutResume: boolean;
    resultAttemptId: string;
    ownReceipt(finish: () => Promise<void>): void;
    /** Archive the accepted queued input without releasing its rows. */
    archiveQueuedInput(): Promise<void>;
    /** Archive the accepted queued input if not yet, and release its rows. */
    onQueueAccepted(): Promise<void>;
  },
) {
  const { execution, continuation, checkpoint } = input;
  const { target } = execution;
  const sessionName = conversationTargetStoreSessionName(target);
  const finishes: (() => Promise<void>)[] = [];
  const ownReceipt = (finish: () => Promise<void>) => {
    finishes.push(finish);
    input.ownReceipt(finish);
  };
  const finish = async () => {
    const results = await Promise.allSettled(finishes.map((run) => run()));
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length)
      throw new AggregateError(errors, "Turn context receipts failed");
  };
  try {
    // The checkpoint seed and the fork seed are alternatives the resolver
    // chose between; neither is re-derived here, so they cannot both fire.
    if ((checkpoint !== null) !== (continuation.kind === "checkpoint"))
      throw new Error(
        "a checkpoint seed is prepared exactly when the continuation is one",
      );
    const syntheticForkSeed =
      continuation.kind === "fork" ? continuation.seed : undefined;
    let acceptedBackendRef: AgentSessionRef | null = null;
    const fork = createRequiredInputReceipt(async () => {
      if (!syntheticForkSeed || !acceptedBackendRef) return;
      await acknowledgeSyntheticForkSeed(deps.effects, {
        projectPath: execution.projectPath,
        sessionName,
        conversationId: target.conversationId,
        seed: syntheticForkSeed,
        backendRef: acceptedBackendRef,
      });
    });
    ownReceipt(fork.finish);
    let activeTicketBlock: string | null = null;
    // Project conversations are session-less and cannot be ticket-linked.
    // A lookup failure degrades to an uncontextualized turn.
    if (target.scope === "session") {
      try {
        activeTicketBlock = await deps.context.getLiveTicketBlock(
          execution.projectPath,
          target.sessionName,
        );
      } catch (error) {
        deps.log.warn("prompt.live_ticket_block_failed", {
          ...target,
          error: getErrorMessage(error),
        });
      }
    }
    const memory = await prepareMemoryContext(deps, {
      projectPath: execution.projectPath,
      conversationId: target.conversationId,
      conversation:
        target.scope === "project"
          ? { kind: "project" }
          : { kind: "session", sessionName: target.sessionName },
      role: execution.role,
      workflowExecutionId: input.workflowContext?.executionId ?? null,
      workflowContextId: input.workflowContext?.contextId ?? null,
      runtimeCreatedWithoutResume: input.runtimeCreatedWithoutResume,
      backendReportedCompactionLastTurn: false,
    });
    const expanded = expandNativeSpecCommandForAgent(input.promptText);
    if (expanded !== input.promptText)
      deps.log.info("prompt.native_spec_command_expanded", {
        ...target,
        requestLength: input.promptText.length,
      });
    const notepad = await prepareNotepadContext(deps, {
      conversationId: target.conversationId,
      promptText: expanded,
    });
    ownReceipt(notepad.finish);
    const passive = await preparePassiveSubscriptionContext(
      deps.subscriptions,
      {
        recipient: {
          projectPath: execution.projectPath,
          conversationId: target.conversationId,
        },
        attemptId: execution.executionAttemptId ?? input.resultAttemptId,
        providedNotepadContext: notepad.references,
        eligible:
          execution.persistence === "durable" &&
          execution.role === null &&
          input.workflowContext === undefined &&
          execution.turn.inputOrigin === "user",
      },
      ownReceipt,
    );
    const summarizedText = await appendLiveReferenceSummaries(notepad.text, {
      read: (target) => deps.context.readLiveReference(target),
    });
    const acceptedNotepadReferences = prepareAcceptedNotepadReferences(
      deps.subscriptions,
      {
        projectPath: execution.projectPath,
        conversationId: target.conversationId,
      },
      notepad.references,
      ownReceipt,
    );
    const contextBlocks = {
      checkpointSeedBlock: checkpoint?.block ?? null,
      passiveBriefingBlock: passive.block,
      activeTicketBlock,
      memoryIndexBlock: memory.block,
      debugContext: buildDebugPromptContext({
        debugMode: execution.debugMode,
        debugLogUrl: deps.debug.getDebugLogUrl(target.conversationId),
        debugManifestPath: getDebugManifestPath(
          execution.worktreePath,
          target.conversationId,
        ),
      }),
    };
    const promptText = assembleTurnPrompt({
      ...contextBlocks,
      userText: summarizedText,
    });
    // Native commands must reach the adapter without host text becoming part
    // of their name or arguments. Keep the assembled input for checkpoints.
    const isNativeCommand = /^\/[\w:-]+(?:\s|$)/.test(notepad.text);
    const promptContext = isNativeCommand
      ? assembleTurnPrompt({
          ...contextBlocks,
          userText: summarizedText.slice(notepad.text.length).trimStart(),
        })
      : undefined;
    let passiveAcceptance: Promise<void> | undefined;
    let notepadAcceptance: Promise<void> | undefined;
    const observeInputAccepted = () => {
      notepadAcceptance ??= notepad.onInputAccepted?.() ?? Promise.resolve();
      void notepadAcceptance.catch(() => {});
      passiveAcceptance ??= passive.onInputAccepted();
      // The attempt owns retries; capture the evidence before unrelated
      // policy persistence can reject this accepted event.
      void passiveAcceptance.catch(() => {});
      void acceptedNotepadReferences.onInputAccepted().catch(() => {});
    };
    // Everything the accepted input releases, in the order the durable
    // handoffs require: preserve accepted user input first, then required
    // context receipts, and release queue ownership last.
    const acknowledgeAccepted = async (
      backendRef: AgentSessionRef | null,
    ): Promise<void> => {
      observeInputAccepted();
      await input.archiveQueuedInput();
      await notepadAcceptance;
      await memory.onInputAccepted?.();
      await passiveAcceptance;
      await acceptedNotepadReferences.onInputAccepted();
      if (syntheticForkSeed && backendRef) {
        acceptedBackendRef ??= backendRef;
        await fork.onInputAccepted();
      }
      await input.onQueueAccepted();
    };
    return {
      promptText,
      userPromptText: input.execution.turn.promptText,
      dispatchPromptText: isNativeCommand ? notepad.text : promptText,
      ...(promptContext ? { promptContext } : {}),
      syntheticForkSeed,
      markDispatched() {
        notepad.markDispatched();
        acceptedNotepadReferences.markDispatched();
        passive.markDispatched();
      },
      markDispatchFailure: (error: unknown) =>
        passive.markDispatchFailure(error),
      observeInputAccepted,
      async onInputAccepted(backendRef: AgentSessionRef | null) {
        if (!checkpoint) {
          await acknowledgeAccepted(backendRef);
          return;
        }
        // A checkpoint delivery hands the receipt what the accepted input
        // owes: the archive, run now in event order ahead of the backend's
        // own entries, and everything else, released only once the
        // acceptance is durable — the queue advanced on this event alone
        // would outrun a reference that never arrives or a write that fails,
        // and nothing durable could then repair it. The receipt records the
        // acceptance before the archive runs, and a repaired receipt
        // completes both obligations without another provider call.
        await checkpoint.onInputAccepted({
          archive: () => input.archiveQueuedInput(),
          acknowledge: () => acknowledgeAccepted(backendRef),
        });
      },
      async onBackendInit(backendRef: AgentSessionRef) {
        await checkpoint?.onBackendInit(backendRef);
      },
      finish,
    };
  } catch (error) {
    await finish();
    throw error;
  }
}

export type PreparedConversationTurnContext = Awaited<
  ReturnType<typeof prepareConversationTurnContext>
>;
