import { buildDebugPromptContext } from "@/lib/workflows/debug/prompt-policy";

import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { ExecutePromptInput } from "./types";
import type { ConversationActorDependencies } from "./actor-dependencies";
import type { ConversationExecutionContext } from "./turn-spec";
import { conversationTargetStoreSessionName } from "@/lib/conversations/conversation-target";
import { getErrorMessage } from "@/lib/shared/errors";
import { expandNativeSpecCommandForAgent } from "@/lib/conversation-commands/native-spec";

import { getDebugManifestPath } from "@/lib/debug-log/service";
import { prepareNotepadContext } from "./pre-turn/notepad-context";
import { prepareMemoryContext } from "./pre-turn/memory-context";
import { prepareWorkflowResultContext } from "./pre-turn/workflow-result-context";
import { acknowledgeSyntheticForkSeed } from "./pre-turn/fork-seed";
import { createRequiredInputReceipt } from "./pre-turn/required-input-receipt";
import type { ContinuationSeed } from "./pre-turn/continuation-seed";
import type { PreparedCheckpointSeed } from "./pre-turn/checkpoint-seed";

export interface PreparedTurnContribution {
  block: string | null;
  onInputAccepted?(): Promise<void>;
  finish?(): Promise<void>;
}

/**
 * Build the effective prompt, prepending debug mode instructions on the
 * first debug turn and phase-specific context on subsequent turns.
 *
 * `activeTicketBlock` is the linked ticket's current view (5.4); it is
 * rebuilt and prepended per turn — transient by design, never baked into
 * session instructions or the persistent runtime, so attachment changes
 * appear on the next turn without runtime recreation (5.5).
 *
 * `workflowResultsBlock` is another transient pre-turn source. It stays out of
 * the message queue and transcript while appearing before the user's content.
 *
 * `notepadChangeNoticeBlock` is the third: a content-free notice that a notepad
 * this conversation was given has changed (R21). Like the others it is
 * agent-facing only — the durable transcript keeps the user's original text.
 *
 * `memoryIndexBlock` is the fourth (spec `memory` R5/D4): the conversation's
 * generated `<memory-index>`, rebuilt per turn from live rows and placed
 * directly below the ticket block so the artifact being worked on reads
 * before the memory about it. Transient like the rest, never baked in.
 *
 * `checkpointSeedBlock` is the frozen CC checkpoint a fresh runtime is seeded
 * from, delivered exactly once on the first ordinary turn after readiness. It
 * leads everything else because it IS the conversation's prior history — the
 * transient blocks describe the present — and it is passed through byte for
 * byte: the saved payload's hash is what acceptance is later recorded against.
 */
export function assembleTurnPrompt(input: {
  userText: string;
  debugContext: string | null;
  activeTicketBlock: string | null;
  workflowResultsBlock: string | null;
  notepadChangeNoticeBlock: string | null;
  memoryIndexBlock: string | null;
  checkpointSeedBlock: string | null;
}): string {
  return [
    input.checkpointSeedBlock,
    input.notepadChangeNoticeBlock,
    input.workflowResultsBlock,
    input.activeTicketBlock,
    input.memoryIndexBlock,
    input.debugContext,
    input.userText,
  ]
    .filter((block) => block !== null && block !== "")
    .join("\n\n");
}

type TurnContextDependencies = Pick<
  ConversationActorDependencies,
  "context" | "effects" | "log"
> & {
  transcript: Pick<
    ConversationActorDependencies["transcript"],
    "readConversationMessages"
  >;
  debug: Pick<ConversationActorDependencies["debug"], "getDebugLogUrl">;
};

export async function prepareTaskPrompt(
  deps: Pick<TurnContextDependencies, "context" | "log">,
  input: Pick<ExecutePromptInput, "projectPath" | "target"> & {
    promptText: string;
  },
): Promise<string> {
  if (input.target.scope === "project") return input.promptText;
  try {
    const block = await deps.context.getLiveTicketBlock(
      input.projectPath,
      input.target.sessionName,
    );
    return block === null
      ? input.promptText
      : `${block}\n\n${input.promptText}`;
  } catch (error) {
    deps.log.warn("task_run.live_ticket_block_failed", {
      ...input.target,
      error: getErrorMessage(error),
    });
    return input.promptText;
  }
}

export async function prepareConversationTurnContext(
  deps: TurnContextDependencies,
  input: {
    execution: ExecutePromptInput;
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
    let workflow: PreparedTurnContribution = { block: null };
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
      workflow = await prepareWorkflowResultContext(
        deps,
        {
          projectPath: execution.projectPath,
          sessionName: target.sessionName,
          originConversationId: target.conversationId,
          attemptId: input.resultAttemptId,
        },
        ownReceipt,
      );
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
    const promptText = assembleTurnPrompt({
      userText: notepad.text,
      checkpointSeedBlock: checkpoint?.block ?? null,
      activeTicketBlock,
      workflowResultsBlock: workflow.block,
      memoryIndexBlock: memory.block,
      notepadChangeNoticeBlock: notepad.block,
      debugContext: buildDebugPromptContext({
        debugMode: execution.debugMode,
        debugLogUrl: deps.debug.getDebugLogUrl(target.conversationId),
        debugManifestPath: getDebugManifestPath(
          execution.worktreePath,
          target.conversationId,
        ),
      }),
    });
    // Everything the accepted input releases, in the order the durable
    // handoffs require: context receipts first, the queue last, because a
    // released row is the one write nothing later could take back.
    const acknowledgeAccepted = async (
      backendRef: AgentSessionRef | null,
    ): Promise<void> => {
      await notepad.onInputAccepted?.();
      await memory.onInputAccepted?.();
      await workflow.onInputAccepted?.();
      if (syntheticForkSeed && backendRef) {
        acceptedBackendRef ??= backendRef;
        await fork.onInputAccepted();
      }
      await input.onQueueAccepted();
    };
    return {
      promptText,
      syntheticForkSeed,
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
