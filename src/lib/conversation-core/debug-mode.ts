import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  DebugCommand,
  DebugCommandEffect,
} from "@/lib/workflows/debug/commands";
import type { DebugCleanupVerificationRequest } from "@/lib/workflows/debug/cleanup-verification";
import type {
  ConversationIdentity,
  ConversationRow,
} from "./conversation-record";
import type { ConversationCore } from "./executor";
import type { DebugVerificationStart } from "./interactive-turns";
import type { InteractiveConversation } from "./schemas";

export type CoreDebugCommandOutcome =
  | { kind: "applied" | "unchanged" }
  | {
      kind: "refused";
      code: "not_found" | "busy" | "invalid_state";
      message: string;
    };

export interface CoreDebugModeDeps {
  core: Pick<
    ConversationCore,
    | "whileIdle"
    | "lastMessageRequest"
    | "sendUserMessage"
    | "runningAttempt"
    | "conversationIdle"
  >;
  place(conversationId: string): InteractiveConversation | null;
  records: {
    readDebugMode(
      identity: ConversationIdentity,
    ): Promise<ConversationRow["debugMode"]>;
    /** Applies the command to the row when its phase allows it, publishing what changed; null otherwise. */
    applyCommand(
      identity: ConversationIdentity,
      command: DebugCommand,
    ): Promise<DebugCommandEffect | null>;
  };
  /** The debug workflow's check of a cleanup report; resolves with the command that reports it. */
  verify(
    request: DebugCleanupVerificationRequest,
  ): Promise<DebugCommand | null>;
  log: Pick<Logger, "info" | "warn">;
}

export interface CoreDebugMode {
  /** A debug command from the person (or a verification's result), applied while the conversation runs nothing. */
  command(
    conversationId: string,
    command: DebugCommand,
  ): Promise<CoreDebugCommandOutcome>;
  /** Checks a cleanup report in the background; its result reaches the session as a command. */
  startVerification(input: DebugVerificationStart): void;
  /** Resolves once the conversation's verification, if any, has reported. */
  settled(conversationId: string): Promise<void>;
}

/**
 * Debug mode on a conversation the core runs. The debug workflow decides
 * (`applyDebugCommand`, finalization, verification); this applies its
 * decisions to the conversation row at the moments the conversation actor
 * did: commands only while nothing runs, a retry as the failed turn's message
 * again, and a verification's result as one more command.
 */
export function createCoreDebugMode(deps: CoreDebugModeDeps): CoreDebugMode {
  const verifications = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();

  async function stopVerification(conversationId: string): Promise<void> {
    const running = verifications.get(conversationId);
    if (running === undefined) return;
    running.controller.abort();
    await running.completion;
  }

  async function retry(
    conversationId: string,
    identity: ConversationIdentity,
  ): Promise<CoreDebugCommandOutcome> {
    const debugMode = await deps.records.readDebugMode(identity);
    const request = deps.core.lastMessageRequest(conversationId);
    if (
      debugMode?.active !== true ||
      !debugMode.lastTurnFailed ||
      request === null
    ) {
      return {
        kind: "refused",
        code: "invalid_state",
        message: "No failed debug turn is available to retry",
      };
    }
    // Its begin clears the failed-turn mark, as any new turn does.
    const admission = await deps.core.sendUserMessage({
      conversationId,
      ...request,
    });
    if (admission.kind === "refused")
      return { kind: "refused", code: "busy", message: admission.message };
    deps.log.info("conversation_core.debug_turn_retried", { conversationId });
    return { kind: "applied" };
  }

  async function command(
    conversationId: string,
    debugCommand: DebugCommand,
  ): Promise<CoreDebugCommandOutcome> {
    const place = deps.place(conversationId);
    if (place === null) {
      return {
        kind: "refused",
        code: "not_found",
        message: `Conversation ${conversationId} is not run by the core`,
      };
    }
    const identity = {
      projectPath: place.projectPath,
      storeSessionName: place.sessionName,
      conversationId,
    };
    if (debugCommand.kind === "retry_turn")
      return retry(conversationId, identity);
    // A new or ended session has no use for the last one's verification; leaving waits for it to stop.
    if (debugCommand.kind === "enter" || debugCommand.kind === "exit")
      await stopVerification(conversationId);
    if (debugCommand.kind === "set_recording") {
      const debugMode = await deps.records.readDebugMode(identity);
      if (
        debugMode?.active === true &&
        debugMode.recording === debugCommand.recording
      )
        return { kind: "unchanged" };
    }
    // Only entering waits on the conversation's durable holds (a checkpoint, a collaboration's claim), as the
    // conversation actor's did: leaving, or recording, must stay possible while one is being repaired.
    const ran = await deps.core.whileIdle(
      conversationId,
      () => deps.records.applyCommand(identity, debugCommand),
      { kind: "debug_command" },
      debugCommand.kind === "enter" ? { holds: "message" } : {},
    );
    if (ran.kind === "busy") {
      return {
        kind: "refused",
        code: "busy",
        message:
          ran.reason ??
          "The conversation is running a turn; try again when it ends",
      };
    }
    if (ran.value === null) {
      return {
        kind: "refused",
        code: "invalid_state",
        message: `${debugCommand.kind} is not valid in the current debug phase`,
      };
    }
    deps.log.info("conversation_core.debug_command_applied", {
      conversationId,
      command: debugCommand.kind,
    });
    return { kind: "applied" };
  }

  return {
    command,
    startVerification(input) {
      const { conversationId } = input.identity;
      verifications.get(conversationId)?.controller.abort();
      const controller = new AbortController();
      const completion = deps
        .verify({
          worktreePath: input.worktreePath,
          conversationId,
          structuredOutput: input.structuredOutput,
          debugSessionId: input.debugSessionId,
          attempt: input.attempt,
          signal: controller.signal,
        })
        .then(async (result) => {
          if (result === null || controller.signal.aborted) return;
          let outcome = await command(conversationId, result);
          // Busy with this check's own cleanup turn (its attempt, or no attempt in its last
          // steps): the result applies once that turn is done. A later turn drops it, as the
          // conversation actor drops it.
          const running = deps.core.runningAttempt(conversationId);
          if (
            outcome.kind === "refused" &&
            outcome.code === "busy" &&
            (running === null || running === input.turnAttemptId)
          ) {
            await deps.core.conversationIdle(conversationId);
            if (!controller.signal.aborted)
              outcome = await command(conversationId, result);
          }
          if (outcome.kind === "refused") {
            deps.log.warn("conversation_core.debug_verification_dropped", {
              conversationId,
              reason: outcome.message,
            });
          }
        })
        .catch((error: unknown) =>
          deps.log.warn("conversation_core.debug_verification_failed", {
            conversationId,
            error: getErrorMessage(error),
          }),
        )
        .finally(() => {
          if (verifications.get(conversationId)?.controller === controller)
            verifications.delete(conversationId);
        });
      verifications.set(conversationId, { controller, completion });
    },
    async settled(conversationId) {
      await verifications.get(conversationId)?.completion;
    },
  };
}
