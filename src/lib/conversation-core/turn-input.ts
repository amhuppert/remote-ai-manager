import type { AgentSessionRef } from "@/lib/shared/schemas";
import { isPromptNotDeliveredFailure } from "@/lib/agent-backends/errors";
import { expandNativeSpecCommandForAgent } from "@/lib/conversation-commands/native-spec";
import { getDebugManifestPath } from "@/lib/debug-log/service";
import { appendLiveReferenceSummaries } from "@/lib/live-references/service";
import { getErrorMessage } from "@/lib/shared/errors";
import { buildDebugPromptContext } from "@/lib/workflows/debug/prompt-policy";
import type { ConversationTurnDependencies } from "@/lib/conversation-core/turn/dependencies";
import { prepareMemoryContext } from "@/lib/conversation-core/contributions/memory-context";
import { prepareNotepadContext } from "@/lib/conversation-core/contributions/notepad-context";
import {
  preparePassiveSubscriptionContext,
  type PassiveSubscriptionContextDependencies,
} from "@/lib/conversation-core/contributions/passive-subscription-context";
import type { PreparedCheckpointSeed } from "@/lib/conversation-checkpoints/checkpoint-seed";
import {
  assembleTurnPrompt,
  type TurnContextExecution,
} from "@/lib/conversation-core/turn/turn-context";

/** How input reaches the agent: as a turn's own input, or into a turn already running. */
export type InputMode = "turn" | "live";

/** One delivery's evidence, as the send observed it (design §4.4). */
export interface InputDelivery {
  dispatched: boolean;
  accepted: { backendRef: AgentSessionRef | null } | null;
  provenUndelivered: boolean;
}

export type DeliveryClass = "accepted" | "not_sent" | "uncertain";

export function classifyDelivery(delivery: InputDelivery): DeliveryClass {
  if (delivery.accepted !== null) return "accepted";
  return !delivery.dispatched || delivery.provenUndelivered
    ? "not_sent"
    : "uncertain";
}

export interface TurnInputDependencies {
  context: Pick<
    ConversationTurnDependencies["context"],
    | "getLiveTicketBlock"
    | "getMemoryIndexBlock"
    | "readLiveReference"
    | "readNotepadForInjection"
  >;
  effects: Pick<
    ConversationTurnDependencies["effects"],
    "recordNotepadDeliveries" | "recordMemoryIndexDeliveries"
  >;
  subscriptions?: PassiveSubscriptionContextDependencies;
  debug: Pick<ConversationTurnDependencies["debug"], "getDebugLogUrl">;
  log: ConversationTurnDependencies["log"];
}

export interface TurnInputRequest {
  mode: InputMode;
  execution: TurnContextExecution & { executionAttemptId: string };
  /** The message as the agent reads it: feedback rendered as prose, images numbered in. */
  promptText: string;
  /** The passive briefing's claim: the turn's own attempt, or a live delivery's. */
  briefingAttemptId: string;
  /** Turn mode only. */
  runtimeCreatedWithoutResume?: boolean;
  /** Turn mode only: the ready checkpoint this turn delivers. */
  checkpoint?: PreparedCheckpointSeed | null;
  /** First once the input is accepted: keep it. */
  archive(): Promise<void>;
  /** Last once the input is accepted: consume the queued rows it came from. */
  release(): Promise<void>;
}

export interface PreparedTurnInput {
  /** Everything the input carries, assembled: what a checkpoint fingerprints. */
  promptText: string;
  /** What is sent: the assembled input, or a native command alone. */
  dispatchPromptText: string;
  userPromptText: string;
  /** For a native command, the context that accompanies it outside its text. */
  promptContext?: string;
  sending(): void;
  failed(error: unknown): void;
  accepted(backendRef: AgentSessionRef | null): Promise<void>;
  backendInit(ref: AgentSessionRef): Promise<void>;
  readonly delivery: InputDelivery;
  settle(): Promise<boolean>;
}

/** One receipt an accepted input owes; a required one stays owned until it is written. */
interface Receipt {
  name: string;
  required: boolean;
  write(): Promise<void>;
}

/**
 * Turn input for the core (design §4.4): one closed list of contributions per
 * delivery mode, rendered ahead of the message, one delivery evidence value,
 * and one order for what an accepted input owes — keep the input, write the
 * required receipts, then the optional one, and release the queued rows last.
 * A receipt that fails neither holds the release back (the agent has the
 * input; holding it for review would offer to send it twice) nor stops the
 * turn: it stays owned, retried at each settlement until it is written. A
 * delivered checkpoint keeps its own gate: what acceptance releases waits for
 * its durable acceptance.
 */
export async function prepareTurnInput(
  deps: TurnInputDependencies,
  request: TurnInputRequest,
): Promise<PreparedTurnInput> {
  const { execution } = request;
  const { target } = execution;
  const conversationId = target.conversationId;
  const ordinary = request.mode === "turn";
  const checkpoint = ordinary ? (request.checkpoint ?? null) : null;
  const recipient = { projectPath: execution.projectPath, conversationId };

  // The conversation's present, read once per turn; a live delivery joins a turn that already has it.
  let ticket: string | null = null;
  if (ordinary && target.scope === "session") {
    try {
      ticket = await deps.context.getLiveTicketBlock(
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
  const memory = ordinary
    ? await prepareMemoryContext(deps, {
        projectPath: execution.projectPath,
        conversationId,
        conversation:
          target.scope === "project"
            ? { kind: "project" }
            : { kind: "session", sessionName: target.sessionName },
        role: execution.role,
        workflowExecutionId: null,
        workflowContextId: null,
        runtimeCreatedWithoutResume:
          request.runtimeCreatedWithoutResume ?? false,
        backendReportedCompactionLastTurn: false,
      })
    : null;
  const debugContext = ordinary
    ? buildDebugPromptContext({
        debugMode: execution.debugMode,
        debugLogUrl: deps.debug.getDebugLogUrl(conversationId),
        debugManifestPath: getDebugManifestPath(
          execution.worktreePath,
          conversationId,
        ),
      })
    : null;

  // The message, rendered the same way whichever way it is delivered.
  const expanded = expandNativeSpecCommandForAgent(request.promptText);
  if (expanded !== request.promptText)
    deps.log.info("prompt.native_spec_command_expanded", {
      ...target,
      requestLength: request.promptText.length,
    });
  const notepad = await prepareNotepadContext(deps, {
    conversationId,
    promptText: expanded,
  });
  const references = notepad.references;
  const passive = await preparePassiveSubscriptionContext(
    deps.subscriptions,
    {
      recipient,
      attemptId: request.briefingAttemptId,
      providedNotepadContext: references,
      eligible:
        execution.persistence === "durable" &&
        execution.role === null &&
        execution.turn.inputOrigin === "user",
    },
    // Settled by this input's own settlement, below.
    () => {},
  );
  const summarized = await appendLiveReferenceSummaries(notepad.text, {
    read: (reference) => deps.context.readLiveReference(reference),
  });
  const blocks = {
    checkpointSeedBlock: checkpoint?.block ?? null,
    passiveBriefingBlock: passive.block,
    activeTicketBlock: ticket,
    memoryIndexBlock: memory?.block ?? null,
    debugContext,
  };
  const promptText = assembleTurnPrompt({ ...blocks, userText: summarized });
  // A native command reaches the adapter without host text in its name or arguments.
  const isNativeCommand = /^\/[\w:-]+(?:\s|$)/.test(notepad.text);
  const promptContext = isNativeCommand
    ? assembleTurnPrompt({
        ...blocks,
        userText: summarized.slice(notepad.text.length).trimStart(),
      })
    : undefined;

  const receipts: Receipt[] = [
    ...(references.length > 0
      ? [
          {
            name: "notepad_deliveries",
            required: true,
            write: () =>
              deps.effects.recordNotepadDeliveries({
                conversationId,
                notepads: references,
              }),
          },
        ]
      : []),
    {
      name: "passive_briefing",
      required: true,
      write: () => passive.onInputAccepted(),
    },
    ...(references.length > 0 &&
    deps.subscriptions?.recordAcceptedNotepadReferences !== undefined
      ? [
          {
            name: "notepad_follows",
            required: true,
            write: async () => {
              await deps.subscriptions?.recordAcceptedNotepadReferences?.(
                recipient,
                references,
              );
            },
          },
        ]
      : []),
    ...(memory?.onInputAccepted !== undefined
      ? [
          {
            name: "memory_index",
            required: false,
            write: memory.onInputAccepted,
          },
        ]
      : []),
  ];
  const written = new Set<Receipt>();
  let archived = false;
  let released = false;
  /** A delivered checkpoint's acceptance is durable and has let the receipts run. */
  let gateOpened = false;
  const delivery: InputDelivery = {
    dispatched: false,
    accepted: null,
    provenUndelivered: false,
  };

  async function archiveOnce(): Promise<void> {
    if (archived) return;
    try {
      await request.archive();
      archived = true;
    } catch (error) {
      deps.log.warn("conversation_core.input_archive_failed", {
        conversationId,
        error: getErrorMessage(error),
      });
    }
  }

  /** Every receipt not yet written, in order, then the release; never throws. */
  async function acknowledge(): Promise<void> {
    for (const receipt of receipts) {
      if (written.has(receipt)) continue;
      try {
        await receipt.write();
        written.add(receipt);
      } catch (error) {
        deps.log.warn("conversation_core.input_receipt_failed", {
          conversationId,
          receipt: receipt.name,
          error: getErrorMessage(error),
        });
      }
    }
    if (released) return;
    try {
      await request.release();
      released = true;
    } catch (error) {
      deps.log.warn("conversation_core.input_release_failed", {
        conversationId,
        error: getErrorMessage(error),
      });
    }
  }

  return {
    promptText,
    dispatchPromptText: isNativeCommand ? notepad.text : promptText,
    userPromptText: execution.turn.promptText,
    ...(promptContext ? { promptContext } : {}),
    delivery,
    sending() {
      delivery.dispatched = true;
      delivery.provenUndelivered = false;
      passive.markDispatched();
      checkpoint?.markDispatched();
    },
    failed(error) {
      delivery.provenUndelivered = isPromptNotDeliveredFailure(error);
      passive.markDispatchFailure(error);
      checkpoint?.markDispatchFailure(error);
    },
    async accepted(backendRef) {
      // Accepted input was certainly sent, whatever the send observer saw.
      delivery.dispatched = true;
      delivery.accepted ??= { backendRef };
      if (checkpoint === null) {
        await archiveOnce();
        await acknowledge();
        return;
      }
      await checkpoint
        .onInputAccepted({
          archive: () => request.archive(),
          acknowledge: () => {
            gateOpened = true;
            return acknowledge();
          },
        })
        .catch((error: unknown) =>
          deps.log.warn("conversation_core.input_receipt_failed", {
            conversationId,
            receipt: "checkpoint_seed",
            error: getErrorMessage(error),
          }),
        );
    },
    async backendInit(ref) {
      await checkpoint?.onBackendInit(ref);
    },
    async settle() {
      let settled = true;
      /** The briefing settles by its own evidence: not sent, or held as uncertain. */
      const finishBriefing = () =>
        passive.finish().catch((error: unknown) => {
          settled = false;
          deps.log.warn("conversation_core.input_receipt_failed", {
            conversationId,
            receipt: "passive_briefing",
            error: getErrorMessage(error),
          });
        });
      if (delivery.accepted === null) {
        await finishBriefing();
      } else if (checkpoint === null) {
        await archiveOnce();
        await acknowledge();
      }
      if (checkpoint !== null) {
        // The seed's own receipt repairs its acceptance, then releases the rest.
        // It reports a failure once before it retries, so a settlement asks twice.
        // It releases once, so receipts that failed after that are retried here.
        const seed = checkpoint;
        await seed
          .finish()
          .catch(() => seed.finish())
          .catch((error: unknown) => {
            settled = false;
            deps.log.warn("conversation_core.input_receipt_failed", {
              conversationId,
              receipt: "checkpoint_seed",
              error: getErrorMessage(error),
            });
          });
        if (gateOpened) await acknowledge();
        else if (settled && delivery.accepted !== null) {
          // Accepted without the reference its acceptance needs: the seed recorded the operation for
          // reconciliation, which owns the input from here. Nothing the gate holds is released.
          await finishBriefing();
          return settled;
        }
      }
      if (delivery.accepted === null) return settled;
      return (
        settled &&
        released &&
        receipts.every((receipt) => !receipt.required || written.has(receipt))
      );
    },
  };
}
