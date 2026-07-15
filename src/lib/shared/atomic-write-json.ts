/**
 * Atomic, crash-durable file writes: write to a unique temp sibling, fsync it,
 * rename over the target, then fsync the parent directory and every ancestor
 * whose directory entry this write created. `rename` is atomic within a
 * filesystem, so a reader never observes a torn or half-written file — it sees
 * either the old contents or the fully-written new contents. The fsyncs force
 * both the file bytes and each new directory entry to disk, so a returned write
 * survives a crash rather than reverting.
 *
 * `atomicWriteJson` is the JSON convenience over `atomicWriteFile`; both share
 * the temp-then-rename core and the best-effort temp cleanup on failure, so a
 * failed write cannot strand temp detritus next to the canonical file.
 *
 * The temp sibling is created with exclusive creation (`open` with the `"wx"`
 * flag) over a `randomUUID`-suffixed name, so two writers — different processes,
 * or the same process writing the same target twice within one tick — always
 * land on distinct temp paths and never truncate each other's temp file. This
 * primitive still does not serialize concurrent writes to the same *target*:
 * both writes complete independently and the last `rename` wins the visible
 * contents. Callers that need a defined winner or read-modify-write safety must
 * layer their own mutex on top.
 */

import { mkdir, open, rename, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * File operations the atomic writer depends on. Method syntax (not property
 * syntax) so TypeScript checks parameters bivariantly, letting the real
 * `node:fs/promises` functions slot in without contravariance friction.
 *
 * Injected only in tests, to observe fsync/rename ordering and to drive
 * concurrent same-target writes deterministically. Production uses
 * `defaultFileOps`.
 */
export interface AtomicWriteFileOps {
  mkdir(dir: string): Promise<void>;
  dirExists(dir: string): boolean;
  /** Exclusively create the temp file, returning its writable handle. */
  openExclusive(tmpPath: string): Promise<AtomicFileHandle>;
  /** Open a directory for fsync; used to durably persist the rename. */
  openDir(dir: string): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
}

/** The subset of `FileHandle` the atomic writer uses. */
export interface AtomicFileHandle {
  write(contents: Uint8Array): Promise<{ bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

function wrapHandle(handle: FileHandle): AtomicFileHandle {
  return {
    async write(contents: Uint8Array): Promise<{ bytesWritten: number }> {
      const result = await handle.write(contents);
      return { bytesWritten: result.bytesWritten };
    },
    sync(): Promise<void> {
      return handle.sync();
    },
    close(): Promise<void> {
      return handle.close();
    },
  };
}

const defaultFileOps: AtomicWriteFileOps = {
  async mkdir(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true });
  },
  dirExists(dir: string): boolean {
    return existsSync(dir);
  },
  async openExclusive(tmpPath: string): Promise<AtomicFileHandle> {
    return wrapHandle(await open(tmpPath, "wx"));
  },
  async openDir(dir: string): Promise<AtomicFileHandle> {
    return wrapHandle(await open(dir, "r"));
  },
  rename(from: string, to: string): Promise<void> {
    return rename(from, to);
  },
  unlink(target: string): Promise<void> {
    return unlink(target);
  },
};

async function ensureParentDir(
  filePath: string,
  ops: AtomicWriteFileOps,
): Promise<readonly string[]> {
  const dir = path.dirname(filePath);
  if (ops.dirExists(dir)) return [dir];

  const dirsToSync = [dir];
  let ancestor = path.dirname(dir);
  while (!ops.dirExists(ancestor)) {
    dirsToSync.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  if (dirsToSync.at(-1) !== ancestor) dirsToSync.push(ancestor);

  await ops.mkdir(dir);
  return dirsToSync;
}

/**
 * fsync `dir` so the file rename or child-directory entry that landed there is
 * durable. Some platforms (notably Windows) reject opening a directory for
 * fsync; known unsupported-operation errors are tolerated because the rename
 * remains atomic for readers. Genuine I/O errors propagate so callers are not
 * told a crash-durable write succeeded when the directory entry was not synced.
 */
async function syncDir(dir: string, ops: AtomicWriteFileOps): Promise<void> {
  let dirHandle: AtomicFileHandle | undefined;
  try {
    dirHandle = await ops.openDir(dir);
    await dirHandle.sync();
  } catch (err) {
    if (!isUnsupportedDirectorySyncError(err)) throw err;
  } finally {
    if (dirHandle) {
      try {
        await dirHandle.close();
      } catch {
        // Nothing actionable if closing the dir handle fails.
      }
    }
  }
}

function isUnsupportedDirectorySyncError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return false;
  if (["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP"].includes(code)) {
    return true;
  }
  return process.platform === "win32" && ["EPERM", "EBADF"].includes(code);
}

/**
 * Atomically and durably write `contents` to `filePath`, creating parent
 * directories as needed. Writes a `randomUUID`-named temp sibling with
 * exclusive creation, fsyncs it, renames it over the target, then fsyncs the
 * target parent and each ancestor whose directory entry was created. On any
 * failure the temp file is removed (best-effort) and the original error is
 * rethrown.
 *
 * `ops` is injectable for testing; production callers omit it.
 */
export async function atomicWriteFile(
  filePath: string,
  contents: string,
  ops: AtomicWriteFileOps = defaultFileOps,
): Promise<void> {
  const dirsToSync = await ensureParentDir(filePath, ops);
  const tmpPath = `${filePath}.tmp.${process.pid}.${randomUUID()}`;

  let handle: AtomicFileHandle;
  try {
    handle = await ops.openExclusive(tmpPath);
  } catch (err) {
    // The exclusive open failed, so no temp file of ours exists to clean up.
    throw err;
  }

  try {
    const bytes = Buffer.from(contents, "utf-8");
    let offset = 0;
    while (offset < bytes.byteLength) {
      const remaining = bytes.subarray(offset);
      const { bytesWritten } = await handle.write(remaining);
      if (
        !Number.isInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        bytesWritten > remaining.byteLength
      ) {
        throw new Error(
          `Atomic write made invalid progress: wrote ${bytesWritten} of ${remaining.byteLength} remaining bytes`,
        );
      }
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    await ops.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await handle.close();
    } catch {
      // Handle may already be closed (post-write path) — ignore.
    }
    try {
      await ops.unlink(tmpPath);
    } catch {
      // Ignore: temp file may already be gone or was renamed.
    }
    throw err;
  }

  for (const dir of dirsToSync) {
    await syncDir(dir, ops);
  }
}

/**
 * Atomically write `value` as pretty-printed JSON (2-space indent) to
 * `filePath`, creating parent directories as needed.
 */
export function atomicWriteJson(
  filePath: string,
  value: unknown,
): Promise<void> {
  return atomicWriteFile(filePath, JSON.stringify(value, null, 2));
}
