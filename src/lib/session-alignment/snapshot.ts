import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";

const logger = createLogger("session-alignment-snapshot");

/**
 * Worktree-relative directory holding immutable, hash-addressed charter
 * snapshots. Distinct from the mutable active mirror at
 * ALIGNMENT_DOCUMENT_PATH: a later activation rewrites the mirror, while every
 * file here stays byte-frozen for as long as something points at it.
 */
export const ALIGNMENT_SNAPSHOT_DIR = ".cc/session-alignment/snapshots";

/**
 * The content hash is used verbatim as a file name, so only a hex digest is
 * addressable — anything else could escape the snapshot directory.
 */
const CONTENT_HASH_PATTERN = /^[0-9a-f]{64}$/;

/** Worktree-relative path of the snapshot for a given charter content hash. */
export function alignmentSnapshotPath(contentHash: string): string {
  return `${ALIGNMENT_SNAPSHOT_DIR}/${contentHash}.md`;
}

/**
 * A snapshot path already holds bytes that are not the charter being captured.
 * The address is the Alignment content hash, which normalizes whitespace, so
 * two byte-different charters are the same version and collide here; the
 * snapshot must hold exact bytes, so the collision is refused rather than
 * resolved. Typed so callers can turn it into an actionable restart error.
 */
export class CharterSnapshotConflictError extends Error {
  constructor(
    readonly filePath: string,
    detail: string,
  ) {
    super(`charter snapshot ${filePath} ${detail}`);
    this.name = "CharterSnapshotConflictError";
  }
}

export interface CharterSnapshotInput {
  worktreePath: string;
  /** sha256 digest of the normalized charter content (see computeAlignmentHash). */
  contentHash: string;
  /** The full charter content to freeze. */
  content: string;
}

export interface CharterSnapshotWriteResult {
  /** Worktree-relative path of the frozen bytes. */
  filePath: string;
  /** False when a snapshot for this hash already existed and was left untouched. */
  created: boolean;
}

/**
 * Injected side-effecting dependencies (method syntax → bivariant params).
 * Real fs by default; tests inject a temp-dir fs — never `vi.mock`.
 */
export interface CharterSnapshotWriterDeps {
  ensureDir(absolutePath: string): Promise<void>;
  /** The file's contents, or null when nothing exists at `absolutePath`. */
  readFileIfPresent(absolutePath: string): Promise<string | null>;
  /**
   * Publish `contents` at `absolutePath` atomically and exclusively: the path
   * either does not exist or holds the complete bytes — it is never observable
   * mid-write — and an existing file is left untouched. Returns whether this
   * call published.
   */
  publishExclusive(absolutePath: string, contents: string): Promise<boolean>;
}

export interface CharterSnapshotWriter {
  /**
   * Materialize the full charter content at
   * `<worktree>/.cc/session-alignment/snapshots/<contentHash>.md` and return
   * its worktree-relative path. Repeat writes of the same charter are
   * idempotent and never rewrite the file.
   *
   * Fail-closed on both mismatch and failure: a returned path always resolves
   * to exactly the requested bytes, so a governing digest can never dereference
   * a different charter or a snapshot that was never written.
   */
  write(input: CharterSnapshotInput): Promise<CharterSnapshotWriteResult>;
}

async function defaultReadFileIfPresent(
  absolutePath: string,
): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Write to a private sibling, then hard-link it into place. `link` fails with
 * EEXIST rather than replacing, which makes publication both atomic (readers
 * never see the final path partially written) and exclusive (a concurrent
 * writer cannot be clobbered) in one step. The sibling shares the snapshot
 * directory so the link never crosses a filesystem.
 */
async function defaultPublishExclusive(
  absolutePath: string,
  contents: string,
): Promise<boolean> {
  const tempPath = path.join(
    path.dirname(absolutePath),
    `.${path.basename(absolutePath)}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, contents, "utf-8");
  try {
    await link(tempPath, absolutePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    // On success this only drops the temporary name; the published file is the
    // same inode.
    await rm(tempPath, { force: true });
  }
}

function resolveDeps(
  overrides: Partial<CharterSnapshotWriterDeps>,
): CharterSnapshotWriterDeps {
  return {
    ensureDir:
      overrides.ensureDir ??
      (async (absolutePath) => {
        await mkdir(absolutePath, { recursive: true });
      }),
    readFileIfPresent: overrides.readFileIfPresent ?? defaultReadFileIfPresent,
    publishExclusive: overrides.publishExclusive ?? defaultPublishExclusive,
  };
}

export function createCharterSnapshotWriter(
  overrides: Partial<CharterSnapshotWriterDeps> = {},
): CharterSnapshotWriter {
  const deps = resolveDeps(overrides);

  /**
   * Accept an existing snapshot only when it holds exactly the charter being
   * captured — the hash alone cannot prove that.
   */
  async function requireFrozenBytes(
    absolutePath: string,
    filePath: string,
    content: string,
  ): Promise<void> {
    const existing = await deps.readFileIfPresent(absolutePath);
    if (existing === content) return;

    const detail =
      existing === null
        ? "disappeared before its bytes could be verified"
        : `already holds ${existing.length} different characters for this content hash`;
    logger.error("align.snapshot_conflict", {
      filePath,
      contentLength: content.length,
      existingLength: existing?.length ?? null,
    });
    throw new CharterSnapshotConflictError(filePath, detail);
  }

  return {
    async write(input) {
      const { worktreePath, contentHash, content } = input;
      if (!CONTENT_HASH_PATTERN.test(contentHash)) {
        throw new Error(
          `charter snapshot requires a sha256 content hash; received ${contentHash.length} characters that are not a hex digest`,
        );
      }

      const filePath = alignmentSnapshotPath(contentHash);
      const absolutePath = path.join(worktreePath, filePath);

      try {
        await deps.ensureDir(path.dirname(absolutePath));

        const existing = await deps.readFileIfPresent(absolutePath);
        if (existing !== null) {
          await requireFrozenBytes(absolutePath, filePath, content);
          logger.info("align.snapshot_reuse", {
            contentHash,
            contentLength: content.length,
            filePath,
          });
          return { filePath, created: false };
        }

        const published = await deps.publishExclusive(absolutePath, content);
        if (!published) {
          // Another writer published between the check and the attempt; its
          // bytes govern, so they must still be this charter's.
          await requireFrozenBytes(absolutePath, filePath, content);
          logger.info("align.snapshot_reuse", {
            contentHash,
            contentLength: content.length,
            filePath,
          });
          return { filePath, created: false };
        }

        logger.info("align.snapshot_write", {
          contentHash,
          contentLength: content.length,
          filePath,
        });
        return { filePath, created: true };
      } catch (error) {
        if (error instanceof CharterSnapshotConflictError) throw error;
        logger.error("align.snapshot_write_failure", {
          contentHash,
          contentLength: content.length,
          filePath,
          error: getErrorMessage(error),
        });
        throw error;
      }
    },
  };
}
