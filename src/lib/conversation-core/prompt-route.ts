import { NextResponse } from "next/server";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type { ApiError } from "@/lib/api/errors";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";
import { hasCollabPrefix, parseConversationCommand } from "@/lib/conversation-commands/parse";
import type { ParsedConversationCommand } from "@/lib/conversation-commands/schemas";
import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import { ticketCommandFallbackMessage } from "@/lib/conversation-commands/ticket-confirmation";
import {
  conversationTargetStoreSessionName,
  type ConversationTarget,
} from "@/lib/conversations/conversation-target";
import { queuedMessageBlocksOrdinaryAdmission } from "@/lib/conversations/message-queue-schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { Logger } from "@/lib/logging";
import type { RunPromptRequest } from "@/lib/prompt/schemas";
import { ProjectCollaborationUnsupportedError } from "@/lib/project-conversations/collaboration-refusal";
import { getErrorMessage } from "@/lib/shared/errors";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { ConversationCore, HoldRefusal, HoldTurn, UserMessageAdmission } from "./executor";
import { QUEUE_REVIEW_REQUIRED_MESSAGE, type ConversationIdentity } from "./conversation-record";

export interface CoreConversationPromptDeps {
  sendUserMessage: ConversationCore["sendUserMessage"];
  /** The conversation runs or has a turn waiting to start. */
  isBusy: ConversationCore["isBusy"];
  /** The core's durable holds (a collaboration's claim, checkpoint maintenance); null when work may start. */
  holdRefusal(conversationId: string, turn: HoldTurn): Promise<HoldRefusal | null>;
  /** A conversation that has not run takes the backend its first input chose. */
  adoptBackend(identity: ConversationIdentity, backend: AgentBackendId): Promise<void>;
  clearPendingPromptText(
    projectPath: string,
    storeSessionName: string,
    conversationId: string,
    expectedText: string,
  ): Promise<boolean>;
  /** The conversation command service: persists the command message and runs the command to its outcome. */
  dispatchCommand(input: ConversationCommandDispatchInput): Promise<RunCommandOutcome>;
  /** A command the backend cannot run, refused before anything is recorded; null when admitted. */
  commandRefusal(prompt: string, backend: AgentBackendId): Promise<Response | null>;
  log: Pick<Logger, "info" | "warn">;
}

export interface CoreConversationPrompt {
  projectPath: string;
  target: ConversationTarget;
  conversation: ConversationState;
  body: RunPromptRequest;
}

/** What a conversation prompt route asks of the core: whether it runs a conversation, and its prompts. */
export interface CoreConversationPrompts {
  owns(conversationId: string): boolean;
  prompt(input: CoreConversationPrompt): Promise<Response>;
  /**
   * Whether `/collab` may take the conversation over now (null when it may),
   * with a fresh conversation taking the backend its first input chose.
   */
  admitCollaboration(input: CoreConversationPrompt): Promise<Response | null>;
}

/** `/collab` is a claim: held as a command would be, and a fresh conversation adopts its chosen backend. */
export async function admitCoreCollaboration(
  deps: Pick<CoreConversationPromptDeps, "isBusy" | "holdRefusal" | "adoptBackend">,
  input: CoreConversationPrompt,
): Promise<Response | null> {
  const { projectPath, target, conversation, body } = input;
  const held = await admitCoreConversationCommand(deps, conversation, "claim");
  if (held !== null) return held;
  const backend = body.backend ?? conversation.agentBackend;
  if (backend === conversation.agentBackend) return null;
  if (conversation.promptCount > 0 || conversation.backendRef !== null) {
    return NextResponse.json(
      {
        error: `Backend mismatch: conversation uses "${conversation.agentBackend}" but request specified "${backend}"`,
        code: "BACKEND_MISMATCH",
      } satisfies ApiError,
      { status: 409 },
    );
  }
  await deps.adoptBackend(
    { projectPath, storeSessionName: conversationTargetStoreSessionName(target), conversationId: conversation.id },
    backend,
  );
  return null;
}

/**
 * A project conversation keeps its existing refusal. A session conversation's
 * `/collab` is started by the session prompt route before it reaches here.
 */
function collaborationRefusal(target: ConversationTarget): Response {
  if (target.scope === "project") {
    const refusal = new ProjectCollaborationUnsupportedError();
    return NextResponse.json({ error: refusal.message, code: refusal.code } satisfies ApiError, {
      status: refusal.statusCode,
    });
  }
  return NextResponse.json(
    {
      error: "Collaboration Mode is not available in core conversations yet",
      code: "CORE_CONVERSATION_UNSUPPORTED",
    } satisfies ApiError,
    { status: 400 },
  );
}

function refusal(admission: Extract<UserMessageAdmission, { kind: "refused" }>): Response {
  const { status, code } =
    admission.code === "busy"
      ? { status: 409, code: "CONVERSATION_BUSY" }
      : admission.code === "owned"
        ? { status: 409, code: "CONVERSATION_OWNED" }
        : admission.code === "stopping"
          ? { status: 503, code: "SERVER_STOPPING" }
          : { status: 409, code: "CONVERSATION_NOT_ENROLLED" };
  return NextResponse.json({ error: admission.message, code } satisfies ApiError, { status });
}

/**
 * Why a conversation command (or `/collab`, a claim) cannot start now, or
 * null. A command runs through the command service rather than the core's
 * mailbox, so it is held here where the core would hold its work: by the row,
 * by a running turn, and by the core's durable holds.
 */
export async function admitCoreConversationCommand(
  deps: Pick<CoreConversationPromptDeps, "isBusy" | "holdRefusal">,
  conversation: ConversationState,
  turn: Extract<HoldTurn, "task" | "claim">,
): Promise<Response | null> {
  const local = commandHold(deps, conversation);
  if (local !== null) return local;
  const held = await deps.holdRefusal(conversation.id, turn);
  if (held === null) return null;
  return NextResponse.json(
    { error: held.message, code: held.code === "owned" ? "CONVERSATION_OWNED" : "CONVERSATION_BUSY" } satisfies ApiError,
    { status: 409 },
  );
}

function commandHold(deps: Pick<CoreConversationPromptDeps, "isBusy">, conversation: ConversationState): Response | null {
  const refuse = (error: string, code: string) =>
    NextResponse.json({ error, code } satisfies ApiError, { status: 409 });
  if (conversation.pendingQueue.some(queuedMessageBlocksOrdinaryAdmission)) {
    return refuse(QUEUE_REVIEW_REQUIRED_MESSAGE, "QUEUE_REVIEW_REQUIRED");
  }
  if (conversation.debugMode?.active === true) return refuse("Exit debug mode first", "DEBUG_MODE_ACTIVE");
  if (conversation.owner !== null) {
    return refuse(`Conversation is held by a running collaboration (workflow "${conversation.owner.workflowId}")`, "CONVERSATION_OWNED");
  }
  if (deps.isBusy(conversation.id)) {
    return refuse("Conversation is busy — a turn is already running", "CONVERSATION_BUSY");
  }
  return null;
}

/** The prompt request's own event stream: what the client reads while the turn runs. */
function eventStream() {
  const encoder = new TextEncoder();
  const sink: { controller: ReadableStreamDefaultController<Uint8Array> | null } = { controller: null };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      sink.controller = controller;
    },
    cancel() {
      // The work belongs to the conversation, not to this request: it runs on.
    },
  });
  let endingReported = false;
  return {
    emit(event: string, data: unknown): void {
      if (event === "error" || event === "aborted") endingReported = true;
      try {
        sink.controller?.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      } catch {
        // The sender went away; the work is unaffected.
      }
    },
    endingReported: () => endingReported,
    close(): void {
      try {
        sink.controller?.close();
      } catch {
        // Already closed.
      }
    },
    response: () =>
      new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
      }),
  };
}

/**
 * A person's prompt to a conversation the core runs: one message into its
 * mailbox, answered with the same event stream the conversation actor's
 * prompts use (content, error, aborted, then done once the turn settles). A
 * conversation command runs through the command service instead.
 */
export async function promptCoreConversation(
  deps: CoreConversationPromptDeps,
  input: CoreConversationPrompt,
): Promise<Response> {
  const { projectPath, target, conversation, body } = input;
  if (conversation.role !== null) {
    return NextResponse.json(
      {
        error: "Managed workflow conversations are not user-interactive",
        code: "MANAGED_CONVERSATION",
      } satisfies ApiError,
      { status: 403 },
    );
  }
  const text = body.prompt.trim();
  if (hasCollabPrefix(text)) return collaborationRefusal(target);
  const feedback = body.documentFeedback !== undefined || body.notepadFeedback !== undefined;
  if (text.length === 0 && (body.images?.length ?? 0) === 0 && !feedback) {
    return NextResponse.json(
      { error: "Either prompt text, an image or feedback is required" } satisfies ApiError,
      { status: 400 },
    );
  }

  // The backend is chosen with the first message and fixed from then on; the
  // turn itself adopts it, so this is only the early answer.
  const backend = body.backend ?? conversation.agentBackend;
  if (backend !== conversation.agentBackend && (conversation.promptCount > 0 || conversation.backendRef !== null)) {
    return NextResponse.json(
      {
        error: `Backend mismatch: conversation uses "${conversation.agentBackend}" but request specified "${backend}"`,
        code: "BACKEND_MISMATCH",
      } satisfies ApiError,
      { status: 409 },
    );
  }
  const clearDraft = () =>
    deps
      .clearPendingPromptText(
        projectPath,
        conversationTargetStoreSessionName(target),
        conversation.id,
        body.submittedPendingPromptText ?? body.prompt,
      )
      .catch((error: unknown) =>
        deps.log.warn("conversation_core.pending_draft_clear_failed", {
          conversationId: conversation.id,
          error: getErrorMessage(error),
        }),
      );

  const command = parseConversationCommand(text);
  if (command !== null) {
    const refused =
      (await deps.commandRefusal(text, backend)) ?? (await admitCoreConversationCommand(deps, conversation, "task"));
    if (refused !== null) return refused;
    // The command service reads the backend from the row: a first input's choice is taken first.
    if (backend !== conversation.agentBackend) {
      await deps.adoptBackend(
        { projectPath, storeSessionName: conversationTargetStoreSessionName(target), conversationId: conversation.id },
        backend,
      );
    }
    return runCommand(deps, input, command, text, clearDraft);
  }

  // Early answer, before the draft is cleared; the turn re-checks the fresh row.
  if (conversation.pendingQueue.some(queuedMessageBlocksOrdinaryAdmission)) {
    deps.log.warn("conversation_core.prompt_held_for_queue_review", { conversationId: conversation.id });
    return NextResponse.json(
      { error: QUEUE_REVIEW_REQUIRED_MESSAGE, code: "QUEUE_REVIEW_REQUIRED" } satisfies ApiError,
      { status: 409 },
    );
  }

  const events = eventStream();
  const admission = await deps.sendUserMessage({
    conversationId: conversation.id,
    text,
    ...(body.images !== undefined && body.images.length > 0 ? { images: body.images } : {}),
    ...(body.documentFeedback !== undefined ? { documentFeedback: body.documentFeedback } : {}),
    ...(body.notepadFeedback !== undefined ? { notepadFeedback: [body.notepadFeedback] } : {}),
    ...(body.modelSelection !== undefined ? { modelSelection: body.modelSelection } : {}),
    ...(body.backend !== undefined ? { backend: body.backend } : {}),
    // Review feedback is composed by CC from comments, not typed by the person.
    inputOrigin: feedback ? "generated" : "user",
    stream: { emit: events.emit },
  });
  if (admission.kind === "refused") {
    events.close();
    deps.log.warn("conversation_core.prompt_refused", { conversationId: conversation.id, code: admission.code });
    return refusal(admission);
  }
  deps.log.info("conversation_core.prompt_accepted", {
    conversationId: conversation.id,
    promptLength: text.length,
  });
  await clearDraft();

  void admission.settled.then(
    (report) => {
      if (!events.endingReported() && report.status !== "succeeded") {
        events.emit(report.status === "failed" ? "error" : "aborted", {
          message: report.failure ?? "The turn did not complete",
        });
      }
      events.emit("done", {});
      events.close();
    },
    (error: unknown) => {
      events.emit("error", { message: getErrorMessage(error) });
      events.emit("done", {});
      events.close();
    },
  );
  return events.response();
}

/**
 * A conversation command (/commit, /merge, …) runs to its outcome through the
 * command service, which records the command message itself; its agent work
 * reaches this conversation as task turns in its own turn order.
 */
function runCommand(
  deps: CoreConversationPromptDeps,
  input: CoreConversationPrompt,
  command: ParsedConversationCommand,
  text: string,
  clearDraft: () => Promise<unknown>,
): Response {
  const { projectPath, target, conversation, body } = input;
  const events = eventStream();
  const modelSelection: BackendModelSelection | undefined = body.modelSelection;
  deps.log.info("conversation_core.command_dispatched", { conversationId: conversation.id, command: command.command });
  void (async () => {
    try {
      const outcome = await deps.dispatchCommand({
        projectPath,
        projectName: target.projectName,
        // A project conversation has no session worktree, which the command service refuses
        // for the commands that need one; its notices still reach the project conversation.
        ...(target.scope === "session"
          ? { sessionName: target.sessionName }
          : { sessionName: null, noticeSessionName: conversationTargetStoreSessionName(target) }),
        conversationId: conversation.id,
        parsed: command,
        rawText: text,
        ...(modelSelection !== undefined ? { modelSelection } : {}),
      });
      await clearDraft();
      const fallback = ticketCommandFallbackMessage(outcome);
      if (fallback !== null) events.emit("error", { message: fallback });
    } catch (error) {
      events.emit("error", { message: getErrorMessage(error) });
    } finally {
      events.emit("done", {});
      events.close();
    }
  })();
  return events.response();
}
