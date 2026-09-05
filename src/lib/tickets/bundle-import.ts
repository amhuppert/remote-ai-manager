import { randomUUID } from "node:crypto";
import type { TicketsRepo } from "@/lib/state-store/tickets-repo";
import { createLogger } from "@/lib/logging";
import {
  sanitizeSnapshotBasename,
  type TicketContentStore,
} from "./content-store";
import type { TicketAttachment, TicketDetail } from "./schemas";
import type { TicketBundle } from "./bundle";

const logger = createLogger("tickets.bundle-import");
export interface BundleImportDeps {
  repo: TicketsRepo;
  contentStore: TicketContentStore;
}

/** Stage immutable files before one atomic ticket insert; imported identities are provenance, never live links. */
export async function importTicketBundle(
  deps: BundleImportDeps,
  bundle: TicketBundle,
  projectPath: string,
  allowDuplicate: boolean,
): Promise<TicketDetail> {
  const ticketId = randomUUID();
  const now = new Date().toISOString();
  const attachments: TicketAttachment[] = [];
  const mappings: string[] = [];
  async function attach(
    fileName: string,
    description: string,
    bytes: Uint8Array,
    mediaType: string | null,
  ) {
    const id = randomUUID();
    const snapshot = await deps.contentStore.capture({
      ticketId,
      attachmentId: id,
      fileName,
      bytes,
    });
    attachments.push({
      id,
      ticketId,
      description,
      createdAt: now,
      updatedAt: now,
      payload: { kind: "file", ...snapshot, mediaType },
    });
    return `${id}-${sanitizeSnapshotBasename(fileName)}`;
  }
  try {
    for (const attachment of bundle.attachments) {
      if (attachment.payload.kind === "note")
        attachments.push({ ...attachment, id: randomUUID(), ticketId });
    }
    for (const document of bundle.documents) {
      const local = await attach(
        document.fileName,
        document.description,
        Buffer.from(document.content, "base64"),
        document.mediaType,
      );
      mappings.push(
        `- ${JSON.stringify(document.source)} → [${document.fileName}](./${encodeURIComponent(local)}) — ${document.description}`,
      );
    }
    const history = {
      ticket: bundle.ticket,
      attachments: bundle.attachments,
      sessions: bundle.sessions,
      relationships: bundle.relationships,
      statusUpdates: bundle.statusUpdates,
      capturedAt: bundle.capturedAt,
      omissions: bundle.omissions,
    };
    const historyPath = await attach(
      "source-history.json",
      "Original ticket metadata, attachment records, relationships, sessions and complete status history",
      Buffer.from(JSON.stringify(history, null, 2)),
      "application/json",
    );
    const updatesPath = await attach(
      "status-history.md",
      "Source ticket status update history (original authors and timestamps)",
      Buffer.from(
        bundle.statusUpdates
          .map(
            (update) =>
              `## ${update.createdAt}\n\nAuthor: ${JSON.stringify(update.author)}\n\n${update.bodyMarkdown}`,
          )
          .join("\n\n---\n\n"),
      ),
      "text/markdown",
    );
    const index = [
      "# Imported ticket context",
      "",
      `Source ticket: ${bundle.ticket.projectPath}#${bundle.ticket.number} (${bundle.ticket.id})`,
      `Captured: ${bundle.capturedAt}`,
      "",
      "These are historical documents. Continue work with fresh conversations. Source ticket numbers and conversation IDs do not address local CC records.",
      "",
      "## Checkout mappings",
      ...bundle.roots.map(
        (root) => `- ${JSON.stringify(root)} → ${JSON.stringify(projectPath)}`,
      ),
      "",
      "## Documents",
      "Links resolve beside this index when Start work materializes the ticket files. Each document is also available through the ticket attachment index.",
      ...mappings,
      "",
      `- [Original ticket records](./${encodeURIComponent(historyPath)})`,
      `- [Status history](./${encodeURIComponent(updatesPath)})`,
      "",
      "## Related tickets (source references)",
      ...bundle.relationships.map(
        (relation) =>
          `- ${relation.role}: ${relation.otherTicket.projectName}#${relation.otherTicket.number} — ${relation.otherTicket.title}\n\n${relation.description}`,
      ),
      "",
      "## Omissions",
      ...(bundle.omissions.length
        ? bundle.omissions.map((item) => `- ${item.source}: ${item.reason}`)
        : ["None."]),
      "",
    ].join("\n");
    await attach(
      "bundle-index.md",
      "Portable context index: source identity, local mappings, history and omissions",
      Buffer.from(index),
      "text/markdown",
    );
    const result = await deps.repo.createWithAttachments(
      { ...bundle.ticket, id: ticketId, projectPath, updatedAt: now },
      attachments,
      { sourceTicketId: bundle.ticket.id, allowDuplicate },
    );
    logger.info("bundle.imported", {
      ticketId,
      number: result.number,
      documents: attachments.length,
      omissions: bundle.omissions.length,
    });
    return result;
  } catch (error) {
    await deps.contentStore.deleteTicket(ticketId).catch((cleanupError) =>
      logger.warn("bundle.cleanup_failed", {
        ticketId,
        error: String(cleanupError),
      }),
    );
    logger.warn("bundle.import_failed", {
      ticketId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
