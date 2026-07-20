import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { conversationReadCommands } from "./attachment-commands";
import {
  sanitizeSnapshotBasename,
  TicketContentError,
  type TicketContentStore,
} from "./content-store";
import { effectiveSnapshotStatus, type TicketAttachment } from "./schemas";

const logger = createLogger("tickets.materialize");

/**
 * Creation-time context materializer: writes a ticket's file attachments and
 * conversation compaction snapshots from the immutable start snapshot into the
 * newly provisioned session worktree, and registers every written file as a
 * reference document carrying the attachment's description.
 *
 * Layout inside the worktree (git-excluded via the provisioning-time `.cc/`
 * exclude rule):
 *
 *   .cc/tickets/<project-number>/
 *   ├── files/<attachment-id>-<file-name>
 *   └── conversations/<attachment-id>-<conversation-id>.md
 *
 * Materialized files are creation-time snapshots; the live ticket block and
 * `cctl ticket` are authoritative afterwards. Only file and conversation
 * attachments materialize — the other kinds stay index-only pointers.
 */

export const TICKET_WORKTREE_DIRNAME = ".cc/tickets";

export interface MaterializedTicketEntry {
  attachmentId: string;
  kind: "file" | "conversation";
  relativePath: string;
}

export interface MaterializeTicketContextInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  ticketNumber: number;
  /** The immutable attachment snapshot taken at start-lock entry. */
  attachments: TicketAttachment[];
}

export interface TicketMaterializerDeps {
  contentStore: Pick<TicketContentStore, "materialize" | "read">;
  registerReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<unknown>;
}

export interface TicketMaterializer {
  materialize(
    input: MaterializeTicketContextInput,
  ): Promise<MaterializedTicketEntry[]>;
}

/**
 * Attachment ids are generated UUIDs, but file names and conversation ids
 * entered through attach-time input; each must already be a safe basename
 * segment.
 */
function assertSafeSegment(value: string, label: string): void {
  if (value !== sanitizeSnapshotBasename(value)) {
    throw new TicketContentError(
      "unsafe_key",
      `${label} is not a safe file name segment`,
    );
  }
}

type ConversationAttachmentPayload = Extract<
  TicketAttachment["payload"],
  { kind: "conversation" }
>;

type CapturedConversationAttachmentPayload = ConversationAttachmentPayload & {
  snapshotKey: string;
  snapshotCapturedAt: string;
};

function isCapturedConversationAttachmentPayload(
  payload: ConversationAttachmentPayload,
): payload is CapturedConversationAttachmentPayload {
  return (
    effectiveSnapshotStatus(payload) === "captured" &&
    payload.snapshotKey !== null &&
    payload.snapshotCapturedAt !== null
  );
}

function renderConversationMarkdown(
  payload: CapturedConversationAttachmentPayload,
  snapshotMarkdown: string,
): string {
  const sessionLine =
    payload.sessionName === null
      ? "project-level conversation"
      : `session \`${payload.sessionName}\``;
  const commands = conversationReadCommands(payload.conversationId, {
    projectName: path.basename(payload.projectPath),
    sessionName: payload.sessionName,
  })
    .map((command) => `- \`${command}\``)
    .join("\n");
  return [
    `# Ticket conversation attachment: ${payload.conversationId}`,
    "",
    `- Source: ${sessionLine}`,
    `- Compaction snapshot captured at: ${payload.snapshotCapturedAt}`,
    "",
    "This is a retained compaction snapshot. Read the source transcript",
    "for anything newer (cheapest first):",
    "",
    commands,
    "",
    "---",
    "",
    snapshotMarkdown,
    "",
  ].join("\n");
}

export function createTicketMaterializer(
  deps: TicketMaterializerDeps,
): TicketMaterializer {
  return {
    async materialize(input) {
      const startedAt = Date.now();
      const ticketRoot = path.resolve(
        input.worktreePath,
        TICKET_WORKTREE_DIRNAME,
        String(input.ticketNumber),
      );

      /**
       * Backstop behind {@link assertSafeSegment}: the resolved destination
       * must provably stay inside the ticket directory.
       */
      function containedDestination(relativePath: string): string {
        const destination = path.resolve(input.worktreePath, relativePath);
        const relation = path.relative(ticketRoot, destination);
        if (relation.startsWith("..") || path.isAbsolute(relation)) {
          throw new TicketContentError(
            "unsafe_key",
            "materialization destination escapes the ticket directory",
          );
        }
        return destination;
      }

      const entries: MaterializedTicketEntry[] = [];
      let skipped = 0;
      for (const attachment of input.attachments) {
        const payload = attachment.payload;
        if (payload.kind === "file") {
          assertSafeSegment(payload.fileName, "fileName");
          const relativePath = path.posix.join(
            TICKET_WORKTREE_DIRNAME,
            String(input.ticketNumber),
            "files",
            `${attachment.id}-${payload.fileName}`,
          );
          await deps.contentStore.materialize(
            payload.snapshotKey,
            containedDestination(relativePath),
          );
          await deps.registerReferenceDocument(
            input.projectPath,
            input.sessionName,
            relativePath,
            attachment.description,
          );
          entries.push({
            attachmentId: attachment.id,
            kind: "file",
            relativePath,
          });
          continue;
        }
        if (payload.kind === "conversation") {
          if (!isCapturedConversationAttachmentPayload(payload)) {
            throw new Error(
              `conversation attachment ${attachment.id} snapshot is ${effectiveSnapshotStatus(payload)}`,
            );
          }
          assertSafeSegment(payload.conversationId, "conversationId");
          const relativePath = path.posix.join(
            TICKET_WORKTREE_DIRNAME,
            String(input.ticketNumber),
            "conversations",
            `${attachment.id}-${payload.conversationId}.md`,
          );
          const destination = containedDestination(relativePath);
          const snapshotBytes = await deps.contentStore.read(
            payload.snapshotKey,
          );
          const markdown = renderConversationMarkdown(
            payload,
            Buffer.from(snapshotBytes).toString("utf8"),
          );
          await mkdir(path.dirname(destination), { recursive: true });
          await writeFile(destination, markdown, "utf8");
          await deps.registerReferenceDocument(
            input.projectPath,
            input.sessionName,
            relativePath,
            attachment.description,
          );
          entries.push({
            attachmentId: attachment.id,
            kind: "conversation",
            relativePath,
          });
          continue;
        }
        skipped += 1;
      }

      logger.info("materialize.completed", {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        ticketNumber: input.ticketNumber,
        fileCount: entries.filter((entry) => entry.kind === "file").length,
        conversationCount: entries.filter(
          (entry) => entry.kind === "conversation",
        ).length,
        skippedCount: skipped,
        durationMs: Date.now() - startedAt,
      });
      return entries;
    },
  };
}
