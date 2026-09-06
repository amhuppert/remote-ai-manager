import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { resolveConfigDir as defaultResolveConfigDir } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import { atomicWriteFile } from "@/lib/shared/atomic-write-json";

const logger = createLogger("graph-workflow-shared-document-store");

/**
 * Central, worktree-independent store for graph-workflow alignment documents.
 *
 * Charter and shared documents are authored inside whichever worktree the
 * registering agent runs in, but lane worktrees fork from the *committed*
 * session branch — so a document one lane writes (and never commits) is
 * invisible to every other lane. This store keeps a copy of each registered
 * document's content under the OS config dir, keyed by execution + the
 * document's worktree-relative path, so it can be re-materialized into any
 * lane worktree regardless of commit state. It mirrors the per-execution
 * layout used by the workflow log system (`<configDir>/workflow-logs/<id>/`).
 */
const STORE_SUBDIR = "workflow-docs";

export interface SharedDocumentStoreDeps {
  resolveConfigDir(): string;
  readFile(absolutePath: string): Promise<string>;
  writeFile(absolutePath: string, contents: string): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
  fileExists(absolutePath: string): boolean;
}

export interface CaptureFromWorktreeInput {
  executionId: string;
  worktreePath: string;
  relativePath: string;
}

export interface ReadStoredDocumentInput {
  executionId: string;
  relativePath: string;
}

export interface SharedDocumentStore {
  /**
   * Copy a document the agent already wrote into its worktree
   * (`<worktreePath>/<relativePath>`) into the central per-execution store.
   * Throws if the source file is absent so the caller can degrade to a warning.
   */
  captureFromWorktree(input: CaptureFromWorktreeInput): Promise<void>;
  /** Read a captured document's content, or null when it was never captured. */
  read(input: ReadStoredDocumentInput): Promise<string | null>;
}

function assertSafeRelativePath(relativePath: string): void {
  if (relativePath.length === 0) {
    throw new Error("Shared document relativePath must not be empty");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(
      `Shared document relativePath must be relative: ${relativePath}`,
    );
  }
  const normalized = path.normalize(relativePath);
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(
      `Shared document relativePath escapes the store: ${relativePath}`,
    );
  }
}

export function createSharedDocumentStore(
  overrides: Partial<SharedDocumentStoreDeps> = {},
): SharedDocumentStore {
  const deps: SharedDocumentStoreDeps = {
    resolveConfigDir: overrides.resolveConfigDir ?? defaultResolveConfigDir,
    readFile:
      overrides.readFile ?? ((absolutePath) => readFile(absolutePath, "utf-8")),
    writeFile: overrides.writeFile ?? atomicWriteFile,
    ensureDir:
      overrides.ensureDir ??
      (async (absolutePath) => {
        await mkdir(absolutePath, { recursive: true });
      }),
    fileExists: overrides.fileExists ?? existsSync,
  };

  function storePathFor(executionId: string, relativePath: string): string {
    assertSafeRelativePath(relativePath);
    return path.join(
      deps.resolveConfigDir(),
      STORE_SUBDIR,
      executionId,
      relativePath,
    );
  }

  async function captureFromWorktree(
    input: CaptureFromWorktreeInput,
  ): Promise<void> {
    const source = path.join(input.worktreePath, input.relativePath);
    const contents = await deps.readFile(source);
    const dest = storePathFor(input.executionId, input.relativePath);
    await deps.ensureDir(path.dirname(dest));
    await deps.writeFile(dest, contents);
    logger.info("graph-workflow.shared_document_store.captured", {
      executionId: input.executionId,
      relativePath: input.relativePath,
      bytes: contents.length,
    });
  }

  async function read(input: ReadStoredDocumentInput): Promise<string | null> {
    const stored = storePathFor(input.executionId, input.relativePath);
    if (!deps.fileExists(stored)) {
      return null;
    }
    return deps.readFile(stored);
  }

  return { captureFromWorktree, read };
}
