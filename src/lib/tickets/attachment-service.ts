import { z } from "zod";
import type { PublishFn } from "@/lib/events/publication";
import { createLogger } from "@/lib/logging";
import {
  projectNameFromPath,
  type TicketsRepo,
} from "@/lib/state-store/tickets-repo";
import {
  attachmentRefreshCommand,
  conversationReadCommands,
} from "./attachment-commands";
import { TicketContentError, type TicketContentStore } from "./content-store";
import { publishTicketChange } from "./events";
import {
  effectiveSnapshotStatus,
  ticketAttachmentSchema,
  type ResolvedAttachment,
  type TicketAttachment,
  type TicketAttachmentKind,
  type TicketAttachmentPayload,
  type TicketDetail,
  type TicketError,
  type TicketResult,
} from "./schemas";
import { formatTicketIdentifier } from "./references";
import { toTicketValidationIssues } from "./service";

const logger = createLogger("tickets.attachments");

// ============================================================
// Boundary inputs (safeParsed)
// ============================================================

const descriptionSchema = ticketAttachmentSchema.shape.description;

export const addTicketAttachmentPayloadInputSchema = z.discriminatedUnion(
  "kind",
  [
    z.object({
      kind: z.literal("file"),
      fileName: z.string().min(1),
      mediaType: z.string().min(1).nullable().default(null),
      bytes: z.instanceof(Uint8Array),
    }),
    z.object({
      kind: z.literal("conversation"),
      projectName: z.string().min(1),
      sessionName: z.string().min(1).nullable().default(null),
      conversationId: z.string().min(1),
    }),
    z.object({
      kind: z.literal("session"),
      projectName: z.string().min(1),
      sessionName: z.string().min(1),
    }),
    z.object({
      kind: z.literal("note"),
      markdown: z.string().min(1),
    }),
  ],
);

export const addTicketAttachmentServiceInputSchema = z.object({
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  attachmentId: z.string().min(1).optional(),
  description: descriptionSchema,
  payload: addTicketAttachmentPayloadInputSchema,
});
export type AddTicketAttachmentServiceInput = z.input<
  typeof addTicketAttachmentServiceInputSchema
>;

export const attachmentServiceIdentitySchema = z.object({
  projectName: z.string().min(1),
  number: z.number().int().positive(),
  attachmentId: z.string().min(1),
});
export type AttachmentServiceIdentity = z.input<
  typeof attachmentServiceIdentitySchema
>;

export const updateTicketAttachmentServiceInputSchema =
  attachmentServiceIdentitySchema.extend({
    description: descriptionSchema.optional(),
    markdown: z.string().min(1).optional(),
  });
export type UpdateTicketAttachmentServiceInput = z.input<
  typeof updateTicketAttachmentServiceInputSchema
>;

// ============================================================
// Outputs
// ============================================================

export interface DeletedTicketAttachment {
  attachmentId: string;
  ticketId: string;
  kind: TicketAttachmentKind;
  ticketUpdatedAt: string;
}

// ============================================================
// Service contract and dependencies
// ============================================================

export interface TicketAttachmentService {
  add(
    input: AddTicketAttachmentServiceInput,
  ): Promise<TicketResult<TicketAttachment>>;
  update(
    input: UpdateTicketAttachmentServiceInput,
  ): Promise<TicketResult<TicketAttachment>>;
  remove(
    input: AttachmentServiceIdentity,
  ): Promise<TicketResult<DeletedTicketAttachment>>;
  resolve(
    input: AttachmentServiceIdentity,
  ): Promise<TicketResult<ResolvedAttachment>>;
}

export interface EnsureConversationCompactionInput {
  projectPath: string;
  projectName: string;
  sessionName: string | null;
  conversationId: string;
}

export type EnsureConversationCompactionResult =
  | { ok: true; markdown: string; capturedAt: string }
  | { ok: false; reason: string };

export interface LiveCompaction {
  markdown: string;
  capturedAt: string;
  coveredEndSeq: number;
}

export interface TicketSessionOverview {
  sessionName: string;
  finished: boolean;
  conversationIds: string[];
}

export interface TicketAttachmentServiceDeps {
  repo: TicketsRepo;
  contentStore: TicketContentStore;
  resolveProjectPath(projectName: string): Promise<string | null>;
  /** Serializes attachment work against deletion of the owning project. */
  runProjectTicketOperation<T>(
    projectPath: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  /**
   * Hands a committed pending conversation attachment to the background
   * snapshot refresher; capture never runs inside the add request.
   */
  scheduleConversationSnapshotRefresh(input: {
    projectName: string;
    number: number;
    attachmentId: string;
  }): void;
  /** Current compaction artifact markdown, if one exists. */
  getLiveCompaction(conversationId: string): Promise<LiveCompaction | null>;
  resolveConversation(
    input: EnsureConversationCompactionInput,
  ): Promise<EnsureConversationCompactionInput | null>;
  conversationExists(
    projectPath: string,
    sessionName: string | null,
    conversationId: string,
  ): Promise<boolean>;
  getSessionOverview(
    projectPath: string,
    sessionName: string,
  ): Promise<TicketSessionOverview | null>;
  /** True while a ticket start may hold attachment blobs (defers removal cleanup). */
  isTicketStartActive(ticketId: string): boolean;
  /**
   * Resolves once no ticket start holds the ticket's blobs (immediately when
   * none is active). Removal cleanup deferred by `isTicketStartActive` runs
   * when this settles, so a deferred blob is reclaimed rather than orphaned.
   */
  onTicketStartReleased(ticketId: string): Promise<void>;
  publish: PublishFn;
  now(): string;
  generateId(): string;
}

// ============================================================
// Helpers
// ============================================================

function fail<T>(error: TicketError): TicketResult<T> {
  return { ok: false, error };
}

function validationFailed<T>(path: string, message: string): TicketResult<T> {
  return fail({ code: "validation_failed", issues: [{ path, message }] });
}

function decodeFileContent(bytes: Uint8Array): {
  encoding: "utf8" | "base64";
  content: string;
} {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (Buffer.from(text, "utf8").equals(buffer)) {
    return { encoding: "utf8", content: text };
  }
  return { encoding: "base64", content: buffer.toString("base64") };
}

export function createTicketAttachmentService(
  deps: TicketAttachmentServiceDeps,
): TicketAttachmentService {
  async function withTicket<T>(
    projectName: string,
    number: number,
    operation: (ticket: TicketDetail) => Promise<TicketResult<T>>,
  ): Promise<TicketResult<T>> {
    const projectPath = await deps.resolveProjectPath(projectName);
    if (projectPath === null) {
      return fail({
        code: "ticket_not_found",
        identifier: formatTicketIdentifier(projectName, number),
      });
    }
    return deps.runProjectTicketOperation(projectPath, async () => {
      const detail = await deps.repo.find(projectPath, number);
      if (detail === null) {
        return fail({
          code: "ticket_not_found",
          identifier: formatTicketIdentifier(projectName, number),
        });
      }
      return operation(detail);
    });
  }

  async function publishAttachmentsChanged(
    projectName: string,
    ticket: TicketDetail,
  ): Promise<void> {
    // The mutation is already committed; a failed list-item read degrades to
    // a structured warning (no event) rather than a thrown error.
    let listItem;
    try {
      listItem = await deps.repo.findListItem(
        ticket.projectPath,
        ticket.number,
      );
    } catch (error) {
      logger.warn("tickets.attachments.event_list_item_failed", {
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

  /** Best-effort blob deletion; a leftover orphan is logged, never thrown. */
  async function deleteBlob(
    ticketId: string,
    snapshotKey: string,
    phase: string,
  ): Promise<void> {
    try {
      await deps.contentStore.delete(snapshotKey);
    } catch (error) {
      logger.warn("tickets.attachments.blob_cleanup_failed", {
        ticketId,
        orphanPathKey: snapshotKey,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Reclaims a removed attachment's blob. While a ticket start holds the
   * ticket's blobs, deletion is deferred until the start releases them; the
   * remove itself never waits on that, so the deferred branch is
   * fire-and-forget with its own failure logging.
   */
  function reclaimRemovedBlob(
    ticketId: string,
    snapshotKey: string,
  ): Promise<void> {
    if (!deps.isTicketStartActive(ticketId)) {
      return deleteBlob(ticketId, snapshotKey, "remove");
    }
    logger.info("tickets.attachments.blob_cleanup_deferred", {
      ticketId,
      orphanPathKey: snapshotKey,
      phase: "remove",
    });
    void deps.onTicketStartReleased(ticketId).then(
      () => deleteBlob(ticketId, snapshotKey, "remove_deferred"),
      (error: unknown) => {
        logger.warn("tickets.attachments.blob_cleanup_failed", {
          ticketId,
          orphanPathKey: snapshotKey,
          phase: "remove_deferred",
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return Promise.resolve();
  }

  async function buildPayload(
    ticket: TicketDetail,
    attachmentId: string,
    payload: z.output<typeof addTicketAttachmentPayloadInputSchema>,
  ): Promise<TicketResult<TicketAttachmentPayload>> {
    switch (payload.kind) {
      case "note":
        return {
          ok: true,
          value: { kind: "note", markdown: payload.markdown },
        };

      case "file": {
        const snapshot = await deps.contentStore.capture({
          ticketId: ticket.id,
          attachmentId,
          fileName: payload.fileName,
          bytes: payload.bytes,
        });
        return {
          ok: true,
          value: {
            kind: "file",
            fileName: snapshot.fileName,
            snapshotKey: snapshot.snapshotKey,
            mediaType: payload.mediaType,
            sizeBytes: snapshot.sizeBytes,
            sha256: snapshot.sha256,
          },
        };
      }

      case "conversation": {
        const projectPath = await deps.resolveProjectPath(payload.projectName);
        if (projectPath === null) {
          return validationFailed(
            "payload.projectName",
            `unknown project: ${payload.projectName}`,
          );
        }
        const conversation = await deps.resolveConversation({
          projectPath,
          projectName: payload.projectName,
          sessionName: payload.sessionName,
          conversationId: payload.conversationId,
        });
        if (conversation === null) {
          return validationFailed(
            "payload.conversationId",
            `unknown conversation: ${payload.conversationId}`,
          );
        }
        // The compaction capture is a multi-minute LLM run; the row commits
        // pending and the background refresher settles the snapshot.
        return {
          ok: true,
          value: {
            kind: "conversation",
            projectPath: conversation.projectPath,
            sessionName: conversation.sessionName,
            conversationId: payload.conversationId,
            snapshotKey: null,
            snapshotCapturedAt: null,
            snapshotStatus: "pending",
          },
        };
      }

      case "session": {
        const projectPath = await deps.resolveProjectPath(payload.projectName);
        if (projectPath === null) {
          return validationFailed(
            "payload.projectName",
            `unknown project: ${payload.projectName}`,
          );
        }
        const overview = await deps.getSessionOverview(
          projectPath,
          payload.sessionName,
        );
        if (overview === null) {
          return validationFailed(
            "payload.sessionName",
            `unknown session: ${payload.sessionName}`,
          );
        }
        return {
          ok: true,
          value: {
            kind: "session",
            projectPath,
            sessionName: payload.sessionName,
          },
        };
      }
    }
  }

  async function resolvePayload(
    attachment: TicketAttachment,
    identifier: string,
  ): Promise<TicketResult<ResolvedAttachment>> {
    const payload = attachment.payload;
    switch (payload.kind) {
      case "note":
        return {
          ok: true,
          value: { kind: "note", attachment, markdown: payload.markdown },
        };

      case "file": {
        let bytes: Uint8Array;
        try {
          bytes = await deps.contentStore.read(payload.snapshotKey);
        } catch (error) {
          if (error instanceof TicketContentError) {
            return fail({
              code: "content_unavailable",
              attachmentId: attachment.id,
              reason: `file snapshot unavailable: ${error.code}`,
            });
          }
          throw error;
        }
        const decoded = decodeFileContent(bytes);
        return {
          ok: true,
          value: {
            kind: "file",
            attachment,
            fileName: payload.fileName,
            mediaType: payload.mediaType,
            sizeBytes: payload.sizeBytes,
            sha256: payload.sha256,
            encoding: decoded.encoding,
            content: decoded.content,
          },
        };
      }

      case "conversation": {
        const snapshotStatus = effectiveSnapshotStatus(payload);
        const retryCommand = attachmentRefreshCommand(
          identifier,
          attachment.id,
        );
        if (snapshotStatus === "pending") {
          return {
            ok: true,
            value: {
              kind: "conversation",
              state: "pending",
              attachment,
              conversationId: payload.conversationId,
              sessionName: payload.sessionName,
              retryCommand,
            },
          };
        }
        if (snapshotStatus === "failed") {
          return {
            ok: true,
            value: {
              kind: "conversation",
              state: "failed",
              attachment,
              conversationId: payload.conversationId,
              sessionName: payload.sessionName,
              error:
                payload.snapshotError ??
                "Conversation snapshot capture failed.",
              retryCommand,
            },
          };
        }
        if (
          payload.snapshotKey === null ||
          payload.snapshotCapturedAt === null
        ) {
          return fail({
            code: "content_unavailable",
            attachmentId: attachment.id,
            reason: "captured conversation snapshot metadata is incomplete",
          });
        }
        const sourceAvailable = await deps.conversationExists(
          payload.projectPath,
          payload.sessionName,
          payload.conversationId,
        );
        if (sourceAvailable) {
          const live = await deps.getLiveCompaction(payload.conversationId);
          if (live !== null) {
            return {
              ok: true,
              value: {
                kind: "conversation",
                attachment,
                conversationId: payload.conversationId,
                sessionName: payload.sessionName,
                source: "live_compaction",
                sourceAvailable: true,
                markdown: live.markdown,
                capturedAt: live.capturedAt,
                readCommands: conversationReadCommands(payload.conversationId, {
                  projectName: projectNameFromPath(payload.projectPath),
                  sessionName: payload.sessionName,
                }),
              },
            };
          }
        }
        let snapshotBytes: Uint8Array;
        try {
          snapshotBytes = await deps.contentStore.read(payload.snapshotKey);
        } catch (error) {
          if (error instanceof TicketContentError) {
            return fail({
              code: "content_unavailable",
              attachmentId: attachment.id,
              reason: `conversation snapshot unavailable: ${error.code}`,
            });
          }
          throw error;
        }
        return {
          ok: true,
          value: {
            kind: "conversation",
            attachment,
            conversationId: payload.conversationId,
            sessionName: payload.sessionName,
            source: "retained_compaction",
            sourceAvailable,
            markdown: Buffer.from(snapshotBytes).toString("utf8"),
            capturedAt: payload.snapshotCapturedAt,
            readCommands: sourceAvailable
              ? conversationReadCommands(payload.conversationId, {
                  projectName: projectNameFromPath(payload.projectPath),
                  sessionName: payload.sessionName,
                })
              : [],
          },
        };
      }

      case "session": {
        const overview = await deps.getSessionOverview(
          payload.projectPath,
          payload.sessionName,
        );
        if (overview === null) {
          return fail({
            code: "content_unavailable",
            attachmentId: attachment.id,
            reason: `session no longer exists: ${payload.sessionName}`,
          });
        }
        return {
          ok: true,
          value: {
            kind: "session",
            attachment,
            projectName: projectNameFromPath(payload.projectPath),
            sessionName: overview.sessionName,
            finished: overview.finished,
            conversationIds: overview.conversationIds,
            readCommands: overview.conversationIds.flatMap((conversationId) =>
              conversationReadCommands(conversationId, {
                projectName: projectNameFromPath(payload.projectPath),
                sessionName: payload.sessionName,
              }),
            ),
          },
        };
      }
    }
  }

  return {
    async add(input) {
      const parsed = addTicketAttachmentServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        logger.info("tickets.attachments.add.invalid_input", {
          issueCount: parsed.error.issues.length,
        });
        return fail({
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        });
      }
      const {
        projectName,
        number,
        attachmentId: requestedId,
        description,
        payload,
      } = parsed.data;
      if (requestedId !== undefined && payload.kind !== "note") {
        return validationFailed(
          "attachmentId",
          "explicit attachment ids are only supported for idempotent notes",
        );
      }
      return withTicket(projectName, number, async (ticket) => {
        const attachmentId = requestedId ?? deps.generateId();
        const existing = ticket.attachments.find(
          (attachment) => attachment.id === attachmentId,
        );
        if (existing !== undefined) {
          logger.info("tickets.attachments.add_idempotent_hit", {
            projectName,
            number,
            attachmentId,
          });
          return { ok: true, value: existing };
        }
        const built = await buildPayload(ticket, attachmentId, payload);
        if (!built.ok) return built;

        const timestamp = deps.now();
        const attachment: TicketAttachment = {
          id: attachmentId,
          ticketId: ticket.id,
          description,
          payload: built.value,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

        // Snapshot-first for captured kinds: the blob exists before the row, so
        // a failed insert compensates by removing the blob — the DB never
        // references missing content.
        const snapshotKey =
          built.value.kind === "file" || built.value.kind === "conversation"
            ? built.value.snapshotKey
            : null;
        let inserted: TicketAttachment;
        try {
          inserted = await deps.repo.addAttachment(attachment);
        } catch (error) {
          if (requestedId !== undefined) {
            const current = await deps.repo.findById(ticket.id);
            const concurrent = current?.attachments.find(
              (candidate) => candidate.id === requestedId,
            );
            if (concurrent !== undefined) {
              logger.info("tickets.attachments.add_idempotent_race", {
                projectName,
                number,
                attachmentId: requestedId,
              });
              return { ok: true, value: concurrent };
            }
          }
          if (snapshotKey !== null) {
            // Compensation ignores the start lock: a start materializes from
            // its lock-entry snapshot, which cannot reference a row that never
            // existed, so the blob is safe to delete immediately.
            await deleteBlob(ticket.id, snapshotKey, "insert_compensation");
          }
          throw error;
        }

        logger.info("tickets.attachments.added", {
          projectName,
          number,
          kind: inserted.payload.kind,
        });
        if (
          inserted.payload.kind === "conversation" &&
          effectiveSnapshotStatus(inserted.payload) === "pending"
        ) {
          // The row is already committed, so a refresher that cannot be
          // reached leaves a pending attachment the retry command can settle
          // — it never turns the add into a failure.
          try {
            deps.scheduleConversationSnapshotRefresh({
              projectName,
              number,
              attachmentId: inserted.id,
            });
          } catch (error) {
            logger.warn("tickets.attachments.snapshot_schedule_failed", {
              projectName,
              number,
              attachmentId: inserted.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        await publishAttachmentsChanged(projectName, ticket);
        return { ok: true, value: inserted };
      });
    },

    async update(input) {
      const parsed = updateTicketAttachmentServiceInputSchema.safeParse(input);
      if (!parsed.success) {
        return fail({
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        });
      }
      const { projectName, number, attachmentId, description, markdown } =
        parsed.data;
      return withTicket(projectName, number, async (ticket) => {
        const existing = ticket.attachments.find(
          (attachment) => attachment.id === attachmentId,
        );
        if (existing === undefined) {
          return fail({
            code: "attachment_not_found",
            identifier: formatTicketIdentifier(projectName, number),
            attachmentId,
          });
        }
        if (markdown !== undefined && existing.payload.kind !== "note") {
          return validationFailed(
            "markdown",
            "markdown is only editable on note attachments",
          );
        }

        const updated = await deps.repo.updateAttachment({
          ticketId: ticket.id,
          attachmentId,
          description,
          payload:
            markdown !== undefined ? { kind: "note", markdown } : undefined,
          updatedAt: deps.now(),
        });
        if (updated === null) {
          return fail({
            code: "attachment_not_found",
            identifier: formatTicketIdentifier(projectName, number),
            attachmentId,
          });
        }

        logger.info("tickets.attachments.updated", {
          projectName,
          number,
          kind: updated.payload.kind,
        });
        await publishAttachmentsChanged(projectName, ticket);
        return { ok: true, value: updated };
      });
    },

    async remove(input) {
      const parsed = attachmentServiceIdentitySchema.safeParse(input);
      if (!parsed.success) {
        return fail({
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        });
      }
      const { projectName, number, attachmentId } = parsed.data;
      return withTicket(projectName, number, async (ticket) => {
        // Row removal commits first; blob reclamation is best-effort
        // afterwards, deferred until any active start releases the ticket's
        // blobs (worst case an unreachable orphan, never a broken DB
        // reference).
        const ticketUpdatedAt = deps.now();
        const deletedResult = await deps.repo.deleteAttachment({
          ticketId: ticket.id,
          attachmentId,
          updatedAt: ticketUpdatedAt,
        });
        if (deletedResult === null) {
          return fail({
            code: "attachment_not_found",
            identifier: formatTicketIdentifier(projectName, number),
            attachmentId,
          });
        }
        const { attachment: deleted, ticketUpdatedAt: committedUpdatedAt } =
          deletedResult;

        const payload = deleted.payload;
        if (payload.kind === "file") {
          await reclaimRemovedBlob(ticket.id, payload.snapshotKey);
        }
        if (
          payload.kind === "conversation" &&
          effectiveSnapshotStatus(payload) === "captured" &&
          payload.snapshotKey !== null
        ) {
          await reclaimRemovedBlob(ticket.id, payload.snapshotKey);
        }

        logger.info("tickets.attachments.removed", {
          projectName,
          number,
          kind: deleted.payload.kind,
        });
        await publishAttachmentsChanged(projectName, ticket);
        return {
          ok: true,
          value: {
            attachmentId: deleted.id,
            ticketId: deleted.ticketId,
            kind: deleted.payload.kind,
            ticketUpdatedAt: committedUpdatedAt,
          },
        };
      });
    },

    async resolve(input) {
      const parsed = attachmentServiceIdentitySchema.safeParse(input);
      if (!parsed.success) {
        return fail({
          code: "validation_failed",
          issues: toTicketValidationIssues(parsed.error),
        });
      }
      const { projectName, number, attachmentId } = parsed.data;
      return withTicket(projectName, number, async (ticket) => {
        const attachment = ticket.attachments.find(
          (candidate) => candidate.id === attachmentId,
        );
        if (attachment === undefined) {
          return fail({
            code: "attachment_not_found",
            identifier: formatTicketIdentifier(projectName, number),
            attachmentId,
          });
        }

        const resolved = await resolvePayload(
          attachment,
          formatTicketIdentifier(projectName, number),
        );
        logger.debug("tickets.attachments.resolved", {
          projectName,
          number,
          kind: attachment.payload.kind,
          outcome: resolved.ok ? "ok" : resolved.error.code,
        });
        return resolved;
      });
    },
  };
}
