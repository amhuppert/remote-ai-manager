import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
/**
 * Server-owned `/ticket` creation: an awaited structured task-run turn in the
 * originating conversation supplies judgment (title, description, work type),
 * then deterministic server code snapshots the conversation's compaction and
 * creates the ticket plus its auto-attached conversation reference in one
 * write-queue transaction. Any generation, validation, compaction, or
 * transaction failure appends a reason notice and persists nothing.
 */

import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import {
  renderCompactTranscript,
  renderedTranscriptToMarkdown,
  renderOptionsSchema,
} from "@/lib/conversations/transcript-render";
import { createLogger } from "@/lib/logging";
import type {
  AppendNoticeInput,
  TranscriptEntriesResult,
} from "@/lib/prompt/transcript";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import type { ExecuteWorkflowTaskRunInput } from "@/lib/workflows/conversation/execute-workflow-task-run";
import type { TaskRunResult } from "@/lib/workflows/conversation/turn-result";
import type { BackendModelSelection } from "@/lib/agent-backends/schemas";
import type {
  EnsureConversationCompactionInput,
  EnsureConversationCompactionResult,
  LiveCompaction,
} from "./attachment-service";
import type { TicketContentStore } from "./content-store";
import { publishTicketChange } from "./events";
import type { TicketProjectOperationContext } from "./project-operation-gate";
import {
  ticketWorkTypeSchema,
  TICKET_DEFAULT_STATUS,
  type TicketAttachment,
  type TicketDetail,
} from "./schemas";
import { formatTicketIdentifier } from "./references";

const logger = createLogger("tickets.slash-command");

/** Upper bound for the field-generation turn — the agent only writes prose. */
const GENERATION_TIMEOUT_MS = 180_000;

/**
 * Byte budget for the fallback context block when the conversation has no
 * resumable backendRef. Deliberately smaller than the full read-endpoint
 * default: the block rides inside a generation prompt, not a paged read.
 */
export const FALLBACK_CONTEXT_BUDGET_BYTES = 65_536;

/**
 * Hard-cap a fallback markdown block at `maxBytes` of UTF-8 without splitting
 * a code point, marking the elision the same way the transcript renderer does.
 */
export function boundFallbackMarkdown(
  markdown: string,
  maxBytes: number,
): { markdown: string; truncated: boolean } {
  const encoded = new TextEncoder().encode(markdown);
  if (encoded.byteLength <= maxBytes) {
    return { markdown, truncated: false };
  }
  // `stream: true` holds back an incomplete trailing sequence instead of
  // emitting U+FFFD for it.
  const bounded = new TextDecoder().decode(encoded.subarray(0, maxBytes), {
    stream: true,
  });
  return {
    markdown: `${bounded}\n\n… [compaction truncated]`,
    truncated: true,
  };
}

const AUTO_ATTACHMENT_DESCRIPTION =
  "Originating conversation, auto-attached by /ticket";

// ============================================================
// Structured output contract
// ============================================================

export const ticketCommandOutputSchema = z.object({
  title: z.string(),
  description: z.string(),
  workType: ticketWorkTypeSchema,
});
export type TicketCommandOutput = z.infer<typeof ticketCommandOutputSchema>;

/**
 * `outputFormat.schema` derived from the validation contract. The dialect
 * marker is transport metadata rather than part of the application contract,
 * so backend adapters receive the complete provider-neutral schema.
 */
const ticketCommandJsonSchema = z.toJSONSchema(ticketCommandOutputSchema);
delete ticketCommandJsonSchema.$schema;
export const TICKET_COMMAND_JSON_SCHEMA: Record<string, unknown> =
  ticketCommandJsonSchema;

// ============================================================
// Pure generation helpers
// ============================================================

export interface TicketGenerationPromptInput {
  /** Free text the user typed after `/ticket` (empty string if none). */
  hint: string;
  /**
   * Bounded compaction/transcript rendering supplied when the conversation
   * has no resumable backendRef; null when native context is available.
   */
  fallbackContext: string | null;
}

export function buildTicketGenerationPrompt(
  input: TicketGenerationPromptInput,
): string {
  const lines = [
    "Your only task right now is to draft the fields for a ticket capturing this conversation's accumulated context.",
    "Do not run tools, edit files, or perform any other work — Command Center creates the ticket deterministically from your structured output.",
    "",
    "Derive from the conversation:",
    "- `title`: a concise, specific summary line for the work.",
    "- `description`: markdown describing the problem or work item, its context, and what done looks like. Write it for a reader without access to this conversation.",
    "- `workType`: one of `feature`, `bug`, `research`, `tech_debt`, `performance`.",
  ];

  if (input.fallbackContext !== null) {
    lines.push(
      "",
      "You have no restored memory of this conversation, so use the conversation context below:",
      "```",
      input.fallbackContext,
      "```",
    );
  }

  if (input.hint !== "") {
    lines.push("", `User guidance for the ticket: ${input.hint}`);
  }

  lines.push(
    "",
    "Respond with the structured output containing `title`, `description`, and `workType`.",
  );

  return lines.join("\n");
}

export type ResolvedTicketGeneration =
  | { ok: true; fields: TicketCommandOutput }
  | { ok: false; reason: string };

export function resolveTicketGeneration(
  result: TaskRunResult,
): ResolvedTicketGeneration {
  if (result.kind === "error") {
    const suffix = result.aborted ? " (aborted)" : "";
    return {
      ok: false,
      reason: `generation turn failed${suffix}: ${result.error}`,
    };
  }
  if (result.kind === "text") {
    return {
      ok: false,
      reason: "generation turn returned text instead of structured output",
    };
  }
  const parsed = ticketCommandOutputSchema.safeParse(result.structuredOutput);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `structured output did not match the ticket schema: ${parsed.error.message}`,
    };
  }
  const title = parsed.data.title.trim();
  if (title === "") {
    return { ok: false, reason: "structured output title is empty" };
  }
  return {
    ok: true,
    fields: {
      title,
      description: parsed.data.description.trim(),
      workType: parsed.data.workType,
    },
  };
}

// ============================================================
// Runner contract and dependencies
// ============================================================

export interface TicketCommandInput {
  projectPath: string;
  projectName: string;
  /** null → project conversation (no session worktree). */
  sessionName: string | null;
  conversationId: string;
  hint: string;
  modelSelection?: BackendModelSelection;
}

export type TicketCommandOutcome =
  | {
      status: "created";
      identifier: string;
      confirmationPersisted: boolean;
    }
  | {
      status: "failed";
      reason: string;
      failureNoticePersisted: boolean;
    };

export interface TicketCommandRunnerDeps {
  repo: TicketsRepo;
  contentStore: TicketContentStore;
  /** Serializes command generation and persistence against project deletion. */
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: (context: TicketProjectOperationContext) => Promise<T>,
  ): Promise<T>;
  getConversation(
    projectPath: string,
    sessionName: string | null,
    conversationId: string,
  ): Promise<{
    backendRef: AgentSessionRef | null;
    transcriptPath: string | null;
  } | null>;
  readTranscriptEntries(
    transcriptPath: string | null,
  ): Promise<TranscriptEntriesResult>;
  /** Current compaction artifact markdown, if one exists. */
  getLiveCompaction(conversationId: string): Promise<LiveCompaction | null>;
  /** Create-if-missing, never force-refresh (capture policy for adds). */
  ensureConversationCompaction(
    input: EnsureConversationCompactionInput,
  ): Promise<EnsureConversationCompactionResult>;
  executeWorkflowTaskRun(
    input: ExecuteWorkflowTaskRunInput,
  ): Promise<TaskRunResult>;
  appendNotice(input: AppendNoticeInput): Promise<void>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

export interface TicketCommandRunner {
  run(input: TicketCommandInput): Promise<TicketCommandOutcome>;
}

// ============================================================
// Runner
// ============================================================

export function createTicketCommandRunner(
  deps: TicketCommandRunnerDeps,
): TicketCommandRunner {
  async function failWithNotice(
    input: TicketCommandInput,
    scopeSessionName: string,
    reason: string,
  ): Promise<TicketCommandOutcome> {
    logger.warn("ticket_command.failed", {
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      reason,
    });
    let failureNoticePersisted = true;
    try {
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `/ticket failed: ${reason} — no ticket was created.`,
        projectName: input.projectName,
        storeSessionName: scopeSessionName,
      });
    } catch (error) {
      failureNoticePersisted = false;
      logger.warn("ticket_command.failure_notice_failed", {
        projectName: input.projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { status: "failed", reason, failureNoticePersisted };
  }

  /**
   * Bounded generation context for conversations without a resumable
   * backendRef: prefer the already-condensed live compaction, fall back to
   * the compact transcript rendering the read endpoint uses.
   */
  async function renderFallbackContext(
    input: TicketCommandInput,
    transcriptPath: string | null,
  ): Promise<string | null> {
    const live = await deps.getLiveCompaction(input.conversationId);
    const result = await deps.readTranscriptEntries(transcriptPath);
    if (live !== null && live.coveredEndSeq >= result.maxSeq) {
      const bounded = boundFallbackMarkdown(
        live.markdown,
        FALLBACK_CONTEXT_BUDGET_BYTES,
      );
      logger.info("ticket_command.fallback_context", {
        conversationId: input.conversationId,
        source: "live_compaction",
        truncated: bounded.truncated,
      });
      return bounded.markdown;
    }
    if (live !== null) {
      logger.info("ticket_command.fallback_compaction_stale", {
        conversationId: input.conversationId,
        coveredEndSeq: live.coveredEndSeq,
        maxSeq: result.maxSeq,
      });
    }
    if (result.entries.length === 0) {
      logger.info("ticket_command.fallback_context", {
        conversationId: input.conversationId,
        source: "none",
      });
      return null;
    }
    const rendered = renderCompactTranscript(
      {
        conversationId: input.conversationId,
        entries: result.entries,
        maxSeq: result.maxSeq,
      },
      renderOptionsSchema.parse({
        includeTools: "summary",
        includeThinking: false,
        maxBytes: FALLBACK_CONTEXT_BUDGET_BYTES,
      }),
    );
    logger.info("ticket_command.fallback_context", {
      conversationId: input.conversationId,
      source: "transcript",
      truncated: rendered.truncated,
    });
    return renderedTranscriptToMarkdown(rendered);
  }

  async function generateFields(
    input: TicketCommandInput,
    scopeSessionName: string,
    fallbackContext: string | null,
  ): Promise<ResolvedTicketGeneration> {
    const startedAt = performance.now();
    try {
      const result = await deps.executeWorkflowTaskRun({
        binding: {
          kind: "durable",
          address: {
            projectPath: input.projectPath,
            target: targetFromStoreSessionName(
              input.projectName,
              scopeSessionName,
              input.conversationId,
            ),
          },
        },
        kind: "task_run",
        executionClass: "nongoverned-task",
        executionProfile: "standard",
        prompt: buildTicketGenerationPrompt({
          hint: input.hint,
          fallbackContext,
        }),
        structuredOutputTurns: "single",
        outputFormat: {
          type: "json_schema",
          schema: TICKET_COMMAND_JSON_SCHEMA,
        },
        timeoutMs: GENERATION_TIMEOUT_MS,
        ...(input.modelSelection !== undefined
          ? { modelSelection: input.modelSelection }
          : {}),
      });
      logger.info("ticket_command.generation_complete", {
        resultKind: result.kind,
        usedFallbackContext: fallbackContext !== null,
        durationMs: Math.round(performance.now() - startedAt),
        conversationId: input.conversationId,
      });
      return resolveTicketGeneration(result);
    } catch (err) {
      return {
        ok: false,
        reason: `generation turn threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
  }

  /** Best-effort compensation for a blob whose ticket row never landed. */
  async function compensateSnapshot(snapshotKey: string): Promise<void> {
    try {
      await deps.contentStore.delete(snapshotKey);
    } catch (error) {
      logger.warn("ticket_command.blob_cleanup_failed", {
        orphanPathKey: snapshotKey,
        phase: "insert_compensation",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function publishCreated(
    input: TicketCommandInput,
    detail: TicketDetail,
  ): Promise<void> {
    // The mutation is already committed; a failed list-item read degrades to
    // a structured warning (no event) rather than a thrown error.
    let listItem;
    try {
      listItem = await deps.repo.findListItem(
        detail.projectPath,
        detail.number,
      );
    } catch (error) {
      logger.warn("ticket_command.event_list_item_failed", {
        projectName: input.projectName,
        number: detail.number,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    publishTicketChange({
      publish: deps.publish,
      logger,
      change: "created",
      projectName: input.projectName,
      ticketNumber: detail.number,
      listItem,
      attachmentIndexChanged: true,
    });
  }

  async function runGated(
    input: TicketCommandInput,
  ): Promise<TicketCommandOutcome> {
    const scopeSessionName =
      input.sessionName ?? PROJECT_CONVERSATION_SESSION_SENTINEL;

    const conversation = await deps.getConversation(
      input.projectPath,
      input.sessionName,
      input.conversationId,
    );
    if (conversation === null) {
      return failWithNotice(input, scopeSessionName, "conversation not found");
    }

    let fallbackContext: string | null;
    try {
      fallbackContext =
        conversation.backendRef === null
          ? await renderFallbackContext(input, conversation.transcriptPath)
          : null;
    } catch (err) {
      return failWithNotice(
        input,
        scopeSessionName,
        `fallback context rendering failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const resolved = await generateFields(
      input,
      scopeSessionName,
      fallbackContext,
    );
    if (!resolved.ok) {
      return failWithNotice(input, scopeSessionName, resolved.reason);
    }

    let ensured: EnsureConversationCompactionResult;
    try {
      ensured = await deps.ensureConversationCompaction({
        projectPath: input.projectPath,
        projectName: input.projectName,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
      });
    } catch (err) {
      ensured = {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    if (!ensured.ok) {
      return failWithNotice(
        input,
        scopeSessionName,
        `conversation compaction failed: ${ensured.reason}`,
      );
    }

    const ticketId = deps.generateId();
    const attachmentId = deps.generateId();
    const timestamp = deps.now();

    let snapshotKey: string;
    try {
      const snapshot = await deps.contentStore.captureText({
        ticketId,
        attachmentId,
        fileName: `compaction-${input.conversationId}.md`,
        text: ensured.markdown,
      });
      snapshotKey = snapshot.snapshotKey;
    } catch (err) {
      return failWithNotice(
        input,
        scopeSessionName,
        `conversation snapshot capture failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const attachment: TicketAttachment = {
      id: attachmentId,
      ticketId,
      description: AUTO_ATTACHMENT_DESCRIPTION,
      payload: {
        kind: "conversation",
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        snapshotKey,
        snapshotCapturedAt: ensured.capturedAt,
        snapshotStatus: "captured",
      },
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    let detail: TicketDetail;
    try {
      detail = await deps.repo.createWithAttachments(
        {
          id: ticketId,
          projectPath: input.projectPath,
          title: resolved.fields.title,
          description: resolved.fields.description,
          workType: resolved.fields.workType,
          status: TICKET_DEFAULT_STATUS,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        [attachment],
      );
    } catch (err) {
      await compensateSnapshot(snapshotKey);
      return failWithNotice(
        input,
        scopeSessionName,
        `ticket persistence failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    const identifier = formatTicketIdentifier(input.projectName, detail.number);
    logger.info("ticket_command.created", {
      projectName: input.projectName,
      sessionName: input.sessionName,
      conversationId: input.conversationId,
      identifier,
      workType: detail.workType,
    });
    await publishCreated(input, detail);

    let confirmationPersisted = true;
    try {
      await deps.appendNotice({
        conversationId: input.conversationId,
        text: `Created ticket ${identifier}: "${detail.title}". This conversation is attached to it.`,
        projectName: input.projectName,
        storeSessionName: scopeSessionName,
      });
    } catch (error) {
      confirmationPersisted = false;
      // The ticket exists; a failed notice must not turn success into failure.
      logger.warn("ticket_command.notice_failed", {
        conversationId: input.conversationId,
        identifier,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return { status: "created", identifier, confirmationPersisted };
  }

  return {
    run(input) {
      return deps.runProjectTicketOperation(input.projectPath, (context) => {
        if (context.projectDeletionPrecededOperation) {
          return failWithNotice(
            input,
            input.sessionName ?? PROJECT_CONVERSATION_SESSION_SENTINEL,
            "project was deleted while the command was waiting",
          );
        }
        return runGated(input);
      });
    },
  };
}
