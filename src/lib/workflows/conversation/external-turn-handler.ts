import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { MessageContentBlock } from "@/types";
import type { TranscriptEntry } from "@/lib/transcript";
import type { ConversationBackendEvent } from "@/lib/agent-backends/conversation";
import { createLogger } from "@/lib/logging";
import { processMessage } from "./actor-implementations";
import type { PromptActorResult } from "./types";

const logger = createLogger("external-turn-handler");

export interface ExternalTurnHandlerIdentity {
  projectPath: string;
  projectName: string;
  sessionName: string;
  conversationId: string;
}

export interface ExternalTurnHandlerRuntime {
  sendToMachine: (event: Record<string, unknown>) => void;
}

export interface ExternalTurnHandlerDeps {
  safeAppendTranscriptEntry: (
    conversationId: string,
    entry: TranscriptEntry,
  ) => Promise<void>;
}

export function createExternalTurnHandler(
  identity: ExternalTurnHandlerIdentity,
  runtime: ExternalTurnHandlerRuntime,
  deps: ExternalTurnHandlerDeps,
): (event: ConversationBackendEvent) => void {
  let contentBlocks: MessageContentBlock[] = [];

  const emit = (_event: string, _data: unknown): void => {
    // Content broadcast to external subscribers is handled by machine status
    // transitions; transcript writes are the important side effect here.
  };

  return (event: ConversationBackendEvent): void => {
    switch (event.type) {
      case "external_turn_started": {
        contentBlocks = [];
        runtime.sendToMachine({ type: "EXTERNAL_TURN_STARTED" });
        return;
      }

      case "provider_event": {
        const message = event.payload as SDKMessage;
        void processMessage(
          message,
          identity.conversationId,
          emit,
          contentBlocks,
          deps.safeAppendTranscriptEntry,
        ).catch((err) => {
          logger.warn("external_turn.process_message_failed", {
            conversationId: identity.conversationId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }

      case "external_turn_completed": {
        const result: PromptActorResult = {
          backendRef: event.result.backendRef,
          costUsd: event.result.costUsd,
          durationMs: event.result.durationMs,
          numTurns: event.result.numTurns,
          contextTokens: event.result.contextTokens,
          contextWindow: event.result.contextWindowMax,
          contentBlocks: event.result.contentBlocks,
          structuredOutput: event.result.structuredOutput,
          aborted: event.result.aborted,
          error: event.result.error,
        };
        runtime.sendToMachine({ type: "EXTERNAL_TURN_COMPLETED", result });
        contentBlocks = [];
        return;
      }

      default:
        return;
    }
  };
}
