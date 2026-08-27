import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";

const logger = createLogger("notepads.content-store");

/**
 * Durable storage for notepad images, rooted at `<config-dir>/notepad-content/`.
 * Layout:
 *
 *   notepad-content/<notepad-uuid>/<image-uuid>/<sanitized-basename>
 *
 * The canonical notepad text addresses these bytes by image id alone, so the
 * key is derived rather than stored input: only generated UUID segments plus a
 * sanitized basename, with a resolved-path containment check before every read,
 * write, or delete so a crafted key can never escape the content root.
 */

/**
 * Directory name of the content root under the CC config dir. Doubles as the
 * stable `orphanPathKey` scope in cleanup-failure logs when per-notepad ids are
 * unknowable (e.g. the project→notepad lookup itself failed): the whole root is
 * then the smallest attributable orphan scope.
 */
export const NOTEPAD_CONTENT_ROOT_DIRNAME = "notepad-content";

export type NotepadContentErrorCode = "unsafe_key" | "snapshot_not_found";

export class NotepadContentError extends Error {
  constructor(
    readonly code: NotepadContentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "NotepadContentError";
  }
}

export interface CaptureNotepadImageInput {
  notepadId: string;
  imageId: string;
  fileName: string;
  bytes: Uint8Array;
}

export interface NotepadImageSnapshot {
  snapshotKey: string;
  fileName: string;
  sizeBytes: number;
  sha256: string;
}

export interface NotepadContentStore {
  capture(input: CaptureNotepadImageInput): Promise<NotepadImageSnapshot>;
  read(snapshotKey: string): Promise<Uint8Array>;
  delete(snapshotKey: string): Promise<void>;
  deleteNotepad(notepadId: string): Promise<void>;
  deleteProject(
    projectPath: string,
    capturedNotepadIds?: string[],
  ): Promise<void>;
}

export interface NotepadContentStoreDeps {
  contentRoot: string;
  /**
   * Maps a project path to its notepad ids. Injected because the filesystem
   * layout is keyed by notepad UUID. `deleteProject` uses this when its caller
   * has not already captured the ids before removing the project rows.
   */
  listNotepadIdsForProject(projectPath: string): Promise<string[]>;
}

const MAX_BASENAME_LENGTH = 120;
const FALLBACK_BASENAME = "image";
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
    throw new NotepadContentError(
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

export function createNotepadContentStore(
  deps: NotepadContentStoreDeps,
): NotepadContentStore {
  const root = path.resolve(deps.contentRoot);

  function containedPath(...segments: string[]): string {
    const resolved = path.resolve(root, ...segments);
    if (!isWithin(root, resolved)) {
      throw new NotepadContentError(
        "unsafe_key",
        "resolved path escapes the notepad content root",
      );
    }
    return resolved;
  }

  function resolveSnapshotPath(snapshotKey: string): string {
    const segments = snapshotKey.split("/");
    if (segments.length !== 3) {
      throw new NotepadContentError(
        "unsafe_key",
        "snapshot key must be <notepadId>/<imageId>/<fileName>",
      );
    }
    const [notepadId, imageId, fileName] = segments;
    if (!notepadId || !imageId || !fileName) {
      throw new NotepadContentError(
        "unsafe_key",
        "snapshot key has empty segments",
      );
    }
    assertIdSegment(notepadId, "notepadId");
    assertIdSegment(imageId, "imageId");
    if (fileName !== sanitizeSnapshotBasename(fileName)) {
      throw new NotepadContentError(
        "unsafe_key",
        "snapshot file name is not in sanitized form",
      );
    }
    return containedPath(notepadId, imageId, fileName);
  }

  return {
    async capture(
      input: CaptureNotepadImageInput,
    ): Promise<NotepadImageSnapshot> {
      assertIdSegment(input.notepadId, "notepadId");
      assertIdSegment(input.imageId, "imageId");
      const fileName = sanitizeSnapshotBasename(input.fileName);
      const snapshotKey = `${input.notepadId}/${input.imageId}/${fileName}`;
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

      const snapshot: NotepadImageSnapshot = {
        snapshotKey,
        fileName,
        sizeBytes: input.bytes.byteLength,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      };
      logger.info("content.captured", {
        notepadId: input.notepadId,
        imageId: input.imageId,
        sizeBytes: snapshot.sizeBytes,
      });
      return snapshot;
    },

    async read(snapshotKey: string): Promise<Uint8Array> {
      const source = resolveSnapshotPath(snapshotKey);
      try {
        return await readFile(source);
      } catch (error) {
        if (isFsError(error, "ENOENT")) {
          throw new NotepadContentError(
            "snapshot_not_found",
            `snapshot ${snapshotKey} does not exist`,
          );
        }
        throw error;
      }
    },

    async delete(snapshotKey: string): Promise<void> {
      const source = resolveSnapshotPath(snapshotKey);
      const imageDir = path.dirname(source);
      const notepadDir = path.dirname(imageDir);
      await rm(source, { force: true });
      try {
        await rmdir(imageDir);
      } catch {
        // A sibling snapshot version keeps the image directory alive.
      }
      try {
        await rmdir(notepadDir);
      } catch {
        // Non-empty or already gone — sibling images keep the dir alive.
      }
      logger.info("content.deleted", { snapshotKey });
    },

    async deleteNotepad(notepadId: string): Promise<void> {
      assertIdSegment(notepadId, "notepadId");
      await rm(containedPath(notepadId), { recursive: true, force: true });
      logger.info("content.notepad_deleted", { notepadId });
    },

    async deleteProject(
      projectPath: string,
      capturedNotepadIds?: string[],
    ): Promise<void> {
      let notepadIds = capturedNotepadIds;
      if (notepadIds === undefined) {
        try {
          notepadIds = await deps.listNotepadIdsForProject(projectPath);
        } catch (error) {
          logger.warn("content.project_cleanup_lookup_failed", {
            projectPath,
            orphanPathKey: NOTEPAD_CONTENT_ROOT_DIRNAME,
            error: error instanceof Error ? error.message : String(error),
          });
          return;
        }
      }
      for (const notepadId of notepadIds) {
        try {
          assertIdSegment(notepadId, "notepadId");
          await rm(containedPath(notepadId), { recursive: true, force: true });
        } catch (error) {
          logger.warn("content.orphaned", {
            projectPath,
            orphanPathKey: notepadId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      logger.info("content.project_deleted", {
        projectPath,
        notepadCount: notepadIds.length,
      });
    },
  };
}
