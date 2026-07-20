import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import {
  projectNameFromPath,
  type CompareAndSwapConversationSnapshotResult,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import type {
  EnsureConversationCompactionInput,
  EnsureConversationCompactionResult,
} from "./attachment-service";
import type { TicketContentStore } from "./content-store";
import { publishTicketChange } from "./events";
import { formatTicketIdentifier } from "./references";
import {
  effectiveSnapshotStatus,
  type ConversationAttachmentPayload,
  type TicketAttachment,
  type TicketDetail,
  type TicketResult,
} from "./schemas";
import { toTicketValidationIssues } from "./service";

const logger = createLogger("tickets.snapshot-refresh");

export const SNAPSHOT_CAPTURE_ERROR =
  "Conversation snapshot capture failed. Retry the snapshot.";
export const SNAPSHOT_CAPTURE_PENDING_ERROR =
  "Conversation snapshot capture is still pending. Retry the snapshot.";
export const INTERRUPTED_SNAPSHOT_ERROR =
  "Conversation snapshot capture was interrupted by a server restart. Retry the snapshot.";

export const conversationSnapshotRefreshInputSchema = z.object({
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  attachmentId: z.string().min(1),
});
export type ConversationSnapshotRefreshInput = z.infer<
  typeof conversationSnapshotRefreshInputSchema
>;

export interface ConversationSnapshotRefreshDeps {
  repo: TicketsRepo;
  contentStore: Pick<TicketContentStore, "captureText" | "delete">;
  resolveProjectPath(projectName: string): Promise<string | null>;
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  ensureConversationCompaction(
    input: EnsureConversationCompactionInput,
  ): Promise<EnsureConversationCompactionResult>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

export interface ConversationSnapshotRefreshService {
  refresh(
    input: ConversationSnapshotRefreshInput,
  ): Promise<TicketResult<TicketAttachment>>;
  schedule(input: ConversationSnapshotRefreshInput): void;
}

export interface ConversationSnapshotStartupRecoveryDeps {
  repo: Pick<TicketsRepo, "recoverPendingConversationSnapshots">;
  now(): string;
}

function failedPayload(
  payload: ConversationAttachmentPayload,
): ConversationAttachmentPayload {
  return {
    kind: "conversation",
    projectPath: payload.projectPath,
    sessionName: payload.sessionName,
    conversationId: payload.conversationId,
    snapshotKey: null,
    snapshotCapturedAt: null,
    snapshotStatus: "failed",
    snapshotError: SNAPSHOT_CAPTURE_ERROR,
  };
}

function capturedPayload(
  payload: ConversationAttachmentPayload,
  snapshotKey: string,
  snapshotCapturedAt: string,
): ConversationAttachmentPayload {
  return {
    kind: "conversation",
    projectPath: payload.projectPath,
    sessionName: payload.sessionName,
    conversationId: payload.conversationId,
    snapshotKey,
    snapshotCapturedAt,
    snapshotStatus: "captured",
  };
}

function attachmentMissing(
  projectName: string,
  number: number,
  attachmentId: string,
): TicketResult<never> {
  return {
    ok: false,
    error: {
      code: "attachment_not_found",
      identifier: formatTicketIdentifier(projectName, number),
      attachmentId,
    },
  };
}

export function createConversationSnapshotRefreshService(
  deps: ConversationSnapshotRefreshDeps,
): ConversationSnapshotRefreshService {
  async function deleteSnapshotBestEffort(
    snapshotKey: string,
    ticketId: string,
    attachmentId: string,
    phase: "discard_candidate" | "retire_previous",
  ): Promise<void> {
    try {
      await deps.contentStore.delete(snapshotKey);
    } catch (error) {
      logger.warn("tickets.snapshot_refresh.blob_cleanup_failed", {
        ticketId,
        attachmentId,
        snapshotKey,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function publishWinningTransition(
    projectName: string,
    ticket: TicketDetail,
  ): Promise<void> {
    let listItem;
    try {
      listItem = await deps.repo.findListItem(
        ticket.projectPath,
        ticket.number,
      );
    } catch (error) {
      logger.warn("tickets.snapshot_refresh.event_list_item_failed", {
        projectName,
        number: ticket.number,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    publishTicketChange({
      publish: deps.publish,
      logger,
      change: "attachments",
      projectName,
      ticketNumber: ticket.number,
      listItem,
      attachmentIndexChanged: true,
    });
  }

  async function currentAttachment(
    ticket: TicketDetail,
    attachmentId: string,
  ): Promise<TicketAttachment | null> {
    const current = await deps.repo.findById(ticket.id);
    return (
      current?.attachments.find(
        (attachment) => attachment.id === attachmentId,
      ) ?? null
    );
  }

  async function settleLostSwap(
    projectName: string,
    ticket: TicketDetail,
    attachmentId: string,
  ): Promise<TicketResult<TicketAttachment>> {
    const current = await currentAttachment(ticket, attachmentId);
    if (current === null) {
      return attachmentMissing(projectName, ticket.number, attachmentId);
    }
    const currentStatus =
      current.payload.kind === "conversation"
        ? effectiveSnapshotStatus(current.payload)
        : null;
    logger.info("tickets.snapshot_refresh.superseded", {
      projectName,
      number: ticket.number,
      attachmentId,
      currentKind: current.payload.kind,
      currentStatus,
    });
    if (
      current.payload.kind === "conversation" &&
      currentStatus !== "captured"
    ) {
      return {
        ok: false,
        error: {
          code: "context_preparation_failed",
          phase: "content",
          reason:
            currentStatus === "failed"
              ? (current.payload.snapshotError ?? SNAPSHOT_CAPTURE_ERROR)
              : SNAPSHOT_CAPTURE_PENDING_ERROR,
        },
      };
    }
    return { ok: true, value: current };
  }

  async function transitionFailure(
    projectName: string,
    ticket: TicketDetail,
    attachment: TicketAttachment,
    payload: ConversationAttachmentPayload,
    cause: unknown,
  ): Promise<TicketResult<TicketAttachment>> {
    logger.warn("tickets.snapshot_refresh.capture_failed", {
      projectName,
      number: ticket.number,
      attachmentId: attachment.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
    const result = await deps.repo.compareAndSwapConversationSnapshot({
      ticketId: ticket.id,
      attachmentId: attachment.id,
      previousPayload: payload,
      payload: failedPayload(payload),
      updatedAt: deps.now(),
    });
    if (result.status === "missing") {
      return attachmentMissing(projectName, ticket.number, attachment.id);
    }
    if (result.status === "lost") {
      return settleLostSwap(projectName, ticket, attachment.id);
    }

    await publishWinningTransition(projectName, ticket);
    return {
      ok: false,
      error: {
        code: "context_preparation_failed",
        phase: "content",
        reason: SNAPSHOT_CAPTURE_ERROR,
      },
    };
  }

  async function refreshInsideGate(
    projectName: string,
    number: number,
    attachmentId: string,
    projectPath: string,
  ): Promise<TicketResult<TicketAttachment>> {
    const ticket = await deps.repo.find(projectPath, number);
    if (ticket === null) {
      return {
        ok: false,
        error: {
          code: "ticket_not_found",
          identifier: formatTicketIdentifier(projectName, number),
        },
      };
    }
    const attachment = ticket.attachments.find(
      (candidate) => candidate.id === attachmentId,
    );
    if (attachment === undefined) {
      return attachmentMissing(projectName, number, attachmentId);
    }
    const payload = attachment.payload;
    if (payload.kind !== "conversation") {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          issues: [
            {
              path: "attachmentId",
              message: "only conversation snapshots can be refreshed",
            },
          ],
        },
      };
    }
    const status = effectiveSnapshotStatus(payload);
    if (status !== "pending" && status !== "failed") {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          issues: [
            {
              path: "attachmentId",
              message:
                "only pending or failed conversation snapshots can be refreshed",
            },
          ],
        },
      };
    }

    logger.info("tickets.snapshot_refresh.started", {
      projectName,
      number,
      ticketId: ticket.id,
      attachmentId,
      previousStatus: status,
    });
    let ensured: EnsureConversationCompactionResult;
    try {
      ensured = await deps.ensureConversationCompaction({
        projectPath: payload.projectPath,
        projectName: projectNameFromPath(payload.projectPath),
        sessionName: payload.sessionName,
        conversationId: payload.conversationId,
      });
    } catch (error) {
      return transitionFailure(projectName, ticket, attachment, payload, error);
    }
    if (!ensured.ok) {
      return transitionFailure(
        projectName,
        ticket,
        attachment,
        payload,
        ensured.reason,
      );
    }

    let candidate;
    try {
      candidate = await deps.contentStore.captureText({
        ticketId: ticket.id,
        attachmentId,
        fileName: `compaction-refresh-${deps.generateId()}.md`,
        text: ensured.markdown,
      });
    } catch (error) {
      return transitionFailure(projectName, ticket, attachment, payload, error);
    }

    let result: CompareAndSwapConversationSnapshotResult;
    try {
      result = await deps.repo.compareAndSwapConversationSnapshot({
        ticketId: ticket.id,
        attachmentId,
        previousPayload: payload,
        payload: capturedPayload(
          payload,
          candidate.snapshotKey,
          ensured.capturedAt,
        ),
        updatedAt: deps.now(),
      });
    } catch (error) {
      await deleteSnapshotBestEffort(
        candidate.snapshotKey,
        ticket.id,
        attachmentId,
        "discard_candidate",
      );
      throw error;
    }
    if (result.status === "missing") {
      await deleteSnapshotBestEffort(
        candidate.snapshotKey,
        ticket.id,
        attachmentId,
        "discard_candidate",
      );
      return attachmentMissing(projectName, number, attachmentId);
    }
    if (result.status === "lost") {
      const currentUsesCandidate =
        result.currentPayload.kind === "conversation" &&
        result.currentPayload.snapshotKey === candidate.snapshotKey;
      if (!currentUsesCandidate) {
        await deleteSnapshotBestEffort(
          candidate.snapshotKey,
          ticket.id,
          attachmentId,
          "discard_candidate",
        );
      }
      return settleLostSwap(projectName, ticket, attachmentId);
    }

    if (
      payload.snapshotKey !== null &&
      payload.snapshotKey !== candidate.snapshotKey
    ) {
      await deleteSnapshotBestEffort(
        payload.snapshotKey,
        ticket.id,
        attachmentId,
        "retire_previous",
      );
    }
    await publishWinningTransition(projectName, ticket);
    logger.info("tickets.snapshot_refresh.captured", {
      projectName,
      number,
      ticketId: ticket.id,
      attachmentId,
      ticketUpdatedAt: result.ticketUpdatedAt,
    });
    return { ok: true, value: result.attachment };
  }

  async function refresh(
    input: ConversationSnapshotRefreshInput,
  ): Promise<TicketResult<TicketAttachment>> {
    const parsed = conversationSnapshotRefreshInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        },
      };
    }
    const { projectName, number, attachmentId } = parsed.data;
    const projectPath = await deps.resolveProjectPath(projectName);
    if (projectPath === null) {
      return {
        ok: false,
        error: {
          code: "ticket_not_found",
          identifier: formatTicketIdentifier(projectName, number),
        },
      };
    }
    return deps.runProjectTicketOperation(projectPath, () =>
      refreshInsideGate(projectName, number, attachmentId, projectPath),
    );
  }

  return {
    refresh,
    schedule(input) {
      void refresh(input).then(
        (result) => {
          if (result.ok) return;
          logger.warn("tickets.snapshot_refresh.background_failed", {
            projectName: input.projectName,
            number: input.number,
            attachmentId: input.attachmentId,
            code: result.error.code,
          });
        },
        (error: unknown) => {
          logger.error("tickets.snapshot_refresh.background_crashed", {
            projectName: input.projectName,
            number: input.number,
            attachmentId: input.attachmentId,
            error: error instanceof Error ? error.message : String(error),
          });
        },
      );
    },
  };
}

export async function recoverInterruptedConversationSnapshots(
  deps: ConversationSnapshotStartupRecoveryDeps,
): Promise<number> {
  const recovered = await deps.repo.recoverPendingConversationSnapshots({
    updatedAt: deps.now(),
    snapshotError: INTERRUPTED_SNAPSHOT_ERROR,
  });
  if (recovered.length > 0) {
    logger.info("tickets.snapshot_refresh.interrupted_swept", {
      count: recovered.length,
    });
  }
  return recovered.length;
}
