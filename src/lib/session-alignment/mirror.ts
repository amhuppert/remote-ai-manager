import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { createReferenceDocument } from "@/lib/state-store";

import { ALIGNMENT_DOCUMENT_PATH } from "./render";

const logger = createLogger("session-alignment-mirror");

const MIRROR_DESCRIPTION =
  "The active session Alignment charter (governing context). " +
  "Application state is the source of truth; this is a read-only worktree copy " +
  "regenerated on activation/update.";

/**
 * The registry entry the mirror writer registers/returns: the
 * reference-documents registry's create/update result plus the session scope
 * the mirror keys on. Registration is idempotent on `filePath` (re-activation
 * updates the existing entry rather than duplicating it).
 */
export interface CharterMirrorRegistryEntry {
  id: string;
  projectPath: string;
  sessionName: string;
  filePath: string;
  description: string;
}

/**
 * Inputs the writer takes for every operation. The charter CONTENT and the
 * worktree PATH are provided by the caller — the writer never reads the charter
 * back from the mirror and never treats the copy as the source of truth (R8.3).
 */
export interface CharterMirrorInput {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  content: string;
}

export type CharterMirrorWriteResult =
  | { ok: true; filePath: string }
  | { ok: false; error: unknown };

export type CharterMirrorEnsureResult =
  | { ok: true; repaired: boolean; filePath: string }
  | { ok: false; error: unknown };

/**
 * Injected side-effecting dependencies (method syntax → bivariant params).
 * Real fs + the existing reference-documents registry by default; tests inject a
 * temp-dir fs and an in-memory registry double — never `vi.mock`.
 */
export interface CharterMirrorWriterDeps {
  writeFile(absolutePath: string, contents: string): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
  fileExists(absolutePath: string): Promise<boolean>;
  registerReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<{ id: string; filePath: string }>;
}

export interface CharterMirrorWriter {
  /**
   * Materialize the charter copy at `<worktree>/.cc/session-alignment/charter.md`
   * and register the reference document pointing at it. Best-effort by contract:
   * any failure surfaces as `{ ok: false, error }` so the caller can log and
   * continue — activation never fails on a mirror error (R8.3).
   */
  write(input: CharterMirrorInput): Promise<CharterMirrorWriteResult>;
  /**
   * Restore the copy only when it is missing (repair-if-missing). Re-uses
   * {@link write}; when the copy already exists it is left untouched and the
   * existing content is authoritative-by-state, not by this file.
   */
  ensure(input: CharterMirrorInput): Promise<CharterMirrorEnsureResult>;
}

async function defaultFileExists(absolutePath: string): Promise<boolean> {
  try {
    await stat(absolutePath);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

function resolveDeps(
  overrides: Partial<CharterMirrorWriterDeps>,
): CharterMirrorWriterDeps {
  return {
    writeFile:
      overrides.writeFile ??
      ((absolutePath, contents) => writeFile(absolutePath, contents, "utf-8")),
    ensureDir:
      overrides.ensureDir ??
      (async (absolutePath) => {
        await mkdir(absolutePath, { recursive: true });
      }),
    fileExists: overrides.fileExists ?? defaultFileExists,
    registerReferenceDocument:
      overrides.registerReferenceDocument ?? createReferenceDocument,
  };
}

export function createCharterMirrorWriter(
  overrides: Partial<CharterMirrorWriterDeps> = {},
): CharterMirrorWriter {
  const deps = resolveDeps(overrides);

  async function write(
    input: CharterMirrorInput,
  ): Promise<CharterMirrorWriteResult> {
    const { projectPath, sessionName, worktreePath, content } = input;
    const absolutePath = path.join(worktreePath, ALIGNMENT_DOCUMENT_PATH);

    try {
      await deps.ensureDir(path.dirname(absolutePath));
      await deps.writeFile(absolutePath, content);
      await deps.registerReferenceDocument(
        projectPath,
        sessionName,
        ALIGNMENT_DOCUMENT_PATH,
        MIRROR_DESCRIPTION,
      );

      logger.info("align.mirror_write", {
        projectName: projectPath,
        sessionName,
        filePath: ALIGNMENT_DOCUMENT_PATH,
        contentLength: content.length,
      });

      return { ok: true, filePath: ALIGNMENT_DOCUMENT_PATH };
    } catch (error) {
      logger.error("align.mirror_write_failure", {
        projectName: projectPath,
        sessionName,
        filePath: ALIGNMENT_DOCUMENT_PATH,
        error: getErrorMessage(error),
      });
      return { ok: false, error };
    }
  }

  async function ensure(
    input: CharterMirrorInput,
  ): Promise<CharterMirrorEnsureResult> {
    const { projectPath, sessionName, worktreePath } = input;
    const absolutePath = path.join(worktreePath, ALIGNMENT_DOCUMENT_PATH);

    let exists: boolean;
    try {
      exists = await deps.fileExists(absolutePath);
    } catch (error) {
      logger.error("align.mirror_repair_failure", {
        projectName: projectPath,
        sessionName,
        filePath: ALIGNMENT_DOCUMENT_PATH,
        error: getErrorMessage(error),
      });
      return { ok: false, error };
    }

    if (exists) {
      return { ok: true, repaired: false, filePath: ALIGNMENT_DOCUMENT_PATH };
    }

    logger.info("align.mirror_repair", {
      projectName: projectPath,
      sessionName,
      filePath: ALIGNMENT_DOCUMENT_PATH,
    });

    const result = await write(input);
    if (!result.ok) {
      return result;
    }
    return { ok: true, repaired: true, filePath: result.filePath };
  }

  return { write, ensure };
}
