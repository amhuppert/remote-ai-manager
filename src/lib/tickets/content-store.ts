import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";

const logger = createLogger("tickets.content-store");

/**
 * Durable snapshot storage for ticket attachments, rooted at
 * `<config-dir>/ticket-content/`. Layout:
 *
 *   ticket-content/<ticket-uuid>/<attachment-uuid>/<sanitized-basename>
 *
 * Keys contain only generated UUID segments plus a sanitized basename, and a
 * resolved-path containment check runs before every read, write, materialize,
 * or delete so a crafted key can never escape the content root.
 */

/**
 * Directory name of the content root under the CC config dir. Doubles as the
 * stable `orphanPathKey` scope in cleanup-failure logs when per-ticket ids are
 * unknowable (e.g. the project→ticket lookup itself failed): the whole root is
 * then the smallest attributable orphan scope.
 */
export const TICKET_CONTENT_ROOT_DIRNAME = "ticket-content";

export type TicketContentErrorCode = "unsafe_key" | "snapshot_not_found";

export class TicketContentError extends Error {
  constructor(
    readonly code: TicketContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TicketContentError";
  }
}

export interface CaptureTicketFileInput {
  ticketId: string;
  attachmentId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface CaptureTicketTextInput {
  ticketId: string;
  attachmentId: string;
  fileName: string;
  text: string;
}

export interface FileSnapshot {
  snapshotKey: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface TicketContentStore {
  capture(input: CaptureTicketFileInput): Promise<FileSnapshot>;
  captureText(input: CaptureTicketTextInput): Promise<FileSnapshot>;
  read(snapshotKey: string): Promise<Uint8Array>;
  materialize(snapshotKey: string, destination: string): Promise<void>;
  delete(snapshotKey: string): Promise<void>;
  deleteTicket(ticketId: string): Promise<void>;
  deleteProject(
    projectPath: string,
    capturedTicketIds?: string[],
  ): Promise<void>;
}

export interface TicketContentStoreDeps {
  contentRoot: string;
  /**
   * Maps a project path to its ticket ids. Injected because the filesystem
   * layout is keyed by ticket UUID. `deleteProject` uses this when its caller
   * has not already captured the ids before removing the project rows.
   */
  listTicketIdsForProject(projectPath: string): Promise<string[]>;
}

const MAX_BASENAME_LENGTH = 120;
const FALLBACK_BASENAME = "attachment";
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Reduces any incoming file name to a safe basename: directories stripped,
 * characters outside a conservative allowlist replaced, leading dots removed
 * (no hidden files, no `.`/`..`), length capped against ENAMETOOLONG.
 * Idempotent, so stored keys re-validate on every access.
 */
export function sanitizeSnapshotBasename(fileName: string): string {
  const base = path.basename(fileName.trim());
  const cleaned = base
    .replace(/[^\p{L}\p{N}._ -]/gu, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, MAX_BASENAME_LENGTH)
    // Truncation may split a surrogate pair; a lone surrogate would break the
    // sanitize-is-idempotent invariant that key re-validation relies on.
    .replace(/[\uD800-\uDBFF]$/, "")
    .trim();
  if (!cleaned) {
    return FALLBACK_BASENAME;
  }
  return cleaned;
}

function assertIdSegment(value: string, label: string): void {
  if (!ID_SEGMENT_PATTERN.test(value)) {
    throw new TicketContentError(
      "unsafe_key",
      `${label} is not a safe path segment`,
    );
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function isFsError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

export function createTicketContentStore(
  deps: TicketContentStoreDeps,
): TicketContentStore {
  const root = path.resolve(deps.contentRoot);

  function containedPath(...segments: string[]): string {
    const resolved = path.resolve(root, ...segments);
    if (!isWithin(root, resolved)) {
      throw new TicketContentError(
        "unsafe_key",
        "resolved path escapes the ticket content root",
      );
    }
    return resolved;
  }

  function resolveSnapshotPath(snapshotKey: string): string {
    const segments = snapshotKey.split("/");
    if (segments.length !== 3) {
      throw new TicketContentError(
        "unsafe_key",
        "snapshot key must be <ticketId>/<attachmentId>/<fileName>",
      );
    }
    const [ticketId, attachmentId, fileName] = segments;
    if (!ticketId || !attachmentId || !fileName) {
      throw new TicketContentError(
        "unsafe_key",
        "snapshot key has empty segments",
      );
    }
    assertIdSegment(ticketId, "ticketId");
    assertIdSegment(attachmentId, "attachmentId");
    if (fileName !== sanitizeSnapshotBasename(fileName)) {
      throw new TicketContentError(
        "unsafe_key",
        "snapshot file name is not in sanitized form",
      );
    }
    return containedPath(ticketId, attachmentId, fileName);
  }

  async function capture(input: CaptureTicketFileInput): Promise<FileSnapshot> {
    assertIdSegment(input.ticketId, "ticketId");
    assertIdSegment(input.attachmentId, "attachmentId");
    const fileName = sanitizeSnapshotBasename(input.fileName);
    const snapshotKey = `${input.ticketId}/${input.attachmentId}/${fileName}`;
    const target = resolveSnapshotPath(snapshotKey);

    const targetDir = path.dirname(target);
    await mkdir(targetDir, { recursive: true });
    const tempPath = path.join(targetDir, `.tmp-${randomUUID()}`);
    try {
      await writeFile(tempPath, input.bytes);
      await rename(tempPath, target);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }

    const snapshot: FileSnapshot = {
      snapshotKey,
      fileName,
      sizeBytes: input.bytes.byteLength,
      sha256: createHash("sha256").update(input.bytes).digest("hex"),
    };
    logger.info("content.captured", {
      ticketId: input.ticketId,
      attachmentId: input.attachmentId,
      sizeBytes: snapshot.sizeBytes,
    });
    return snapshot;
  }

  return {
    capture,

    captureText(input: CaptureTicketTextInput): Promise<FileSnapshot> {
      return capture({
        ticketId: input.ticketId,
        attachmentId: input.attachmentId,
        fileName: input.fileName,
        bytes: Buffer.from(input.text, "utf8"),
      });
    },

    async read(snapshotKey: string): Promise<Uint8Array> {
      const source = resolveSnapshotPath(snapshotKey);
      try {
        return await readFile(source);
      } catch (error) {
        if (isFsError(error, "ENOENT")) {
          throw new TicketContentError(
            "snapshot_not_found",
            `snapshot ${snapshotKey} does not exist`,
          );
        }
        throw error;
      }
    },

    async materialize(snapshotKey: string, destination: string): Promise<void> {
      const source = resolveSnapshotPath(snapshotKey);
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        await copyFile(source, destination);
      } catch (error) {
        if (isFsError(error, "ENOENT")) {
          throw new TicketContentError(
            "snapshot_not_found",
            `snapshot ${snapshotKey} does not exist`,
          );
        }
        throw error;
      }
      logger.debug("content.materialized", { snapshotKey });
    },

    async delete(snapshotKey: string): Promise<void> {
      const source = resolveSnapshotPath(snapshotKey);
      const attachmentDir = path.dirname(source);
      const ticketDir = path.dirname(attachmentDir);
      await rm(source, { force: true });
      try {
        await rmdir(attachmentDir);
      } catch {
        // A sibling snapshot version keeps the attachment directory alive.
      }
      try {
        await rmdir(ticketDir);
      } catch {
        // Non-empty or already gone — sibling attachments keep the dir alive.
      }
      logger.info("content.deleted", { snapshotKey });
    },

    async deleteTicket(ticketId: string): Promise<void> {
      assertIdSegment(ticketId, "ticketId");
      const ticketDir = containedPath(ticketId);
      await rm(ticketDir, { recursive: true, force: true });
      logger.info("content.ticket_deleted", { ticketId });
    },

    async deleteProject(
      projectPath: string,
      capturedTicketIds?: string[],
    ): Promise<void> {
      let ticketIds = capturedTicketIds;
      if (ticketIds === undefined) {
        try {
          ticketIds = await deps.listTicketIdsForProject(projectPath);
        } catch (error) {
          logger.warn("content.project_cleanup_lookup_failed", {
            projectPath,
            orphanPathKey: TICKET_CONTENT_ROOT_DIRNAME,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      for (const ticketId of ticketIds) {
        try {
          assertIdSegment(ticketId, "ticketId");
          await rm(containedPath(ticketId), { recursive: true, force: true });
        } catch (error) {
          logger.warn("content.orphaned", {
            projectPath,
            orphanPathKey: ticketId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      logger.info("content.project_deleted", {
        projectPath,
        ticketCount: ticketIds.length,
      });
    },
  };
}
