import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
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
 * document's immutable content under the OS config dir, keyed by execution +
 * content hash, so it can be re-materialized into any
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
  contentHash?: string | null;
}

export interface SharedDocumentContent {
  contentHash: string;
}

export interface SharedDocumentStore {
  /**
   * Copy a document the agent already wrote into its worktree
   * (`<worktreePath>/<relativePath>`) into the central per-execution store.
   * Returns an immutable object reference. Registration may publish that
   * reference only after capture succeeds; an unreferenced object is harmless.
   */
  captureFromWorktree(
    input: CaptureFromWorktreeInput,
  ): Promise<SharedDocumentContent>;
  captureContent(input: {
    executionId: string;
    contents: string;
  }): Promise<SharedDocumentContent>;
  /** Read a captured document's content, or null when it was never captured. */
  read(input: ReadStoredDocumentInput): Promise<string | null>;
  /** One-time cutover only; ordinary readers never consult path-keyed files. */
  migrateLegacyDocument(
    input: Omit<ReadStoredDocumentInput, "contentHash">,
  ): Promise<SharedDocumentContent | null>;
}

export function hashSharedDocumentContent(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
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

  function executionDirectory(executionId: string): string {
    if (
      !executionId ||
      executionId === "." ||
      executionId === ".." ||
      /[/\\]/.test(executionId)
    ) {
      throw new Error("Invalid shared document execution id");
    }
    return path.join(deps.resolveConfigDir(), STORE_SUBDIR, executionId);
  }

  function legacyPathFor(executionId: string, relativePath: string): string {
    assertSafeRelativePath(relativePath);
    return path.join(executionDirectory(executionId), relativePath);
  }

  function objectPathFor(executionId: string, contentHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(contentHash)) {
      throw new Error("Invalid shared document content hash");
    }
    return path.join(executionDirectory(executionId), "objects", contentHash);
  }

  async function captureContent(input: {
    executionId: string;
    contents: string;
  }): Promise<SharedDocumentContent> {
    const contentHash = hashSharedDocumentContent(input.contents);
    const dest = objectPathFor(input.executionId, contentHash);
    await deps.ensureDir(path.dirname(dest));
    await deps.writeFile(dest, input.contents);
    return { contentHash };
  }

  async function captureFromWorktree(
    input: CaptureFromWorktreeInput,
  ): Promise<SharedDocumentContent> {
    assertSafeRelativePath(input.relativePath);
    const source = path.join(input.worktreePath, input.relativePath);
    const contents = await deps.readFile(source);
    const reference = await captureContent({
      executionId: input.executionId,
      contents,
    });
    logger.info("graph-workflow.shared_document_store.captured", {
      executionId: input.executionId,
      relativePath: input.relativePath,
      contentHash: reference.contentHash,
      bytes: Buffer.byteLength(contents, "utf8"),
    });
    return reference;
  }

  async function read(input: ReadStoredDocumentInput): Promise<string | null> {
    assertSafeRelativePath(input.relativePath);
    if (!input.contentHash) return null;
    const stored = objectPathFor(input.executionId, input.contentHash);
    if (!deps.fileExists(stored)) {
      return null;
    }
    const contents = await deps.readFile(stored);
    if (hashSharedDocumentContent(contents) !== input.contentHash) {
      logger.error("graph-workflow.shared_document_store.hash_mismatch", {
        executionId: input.executionId,
        relativePath: input.relativePath,
        contentHash: input.contentHash,
      });
      throw new Error(
        `Shared document content hash mismatch: ${input.relativePath}`,
      );
    }
    return contents;
  }

  async function migrateLegacyDocument(
    input: Omit<ReadStoredDocumentInput, "contentHash">,
  ): Promise<SharedDocumentContent | null> {
    const source = legacyPathFor(input.executionId, input.relativePath);
    if (!deps.fileExists(source)) return null;
    const contents = await deps.readFile(source);
    const reference = await captureContent({
      executionId: input.executionId,
      contents,
    });
    logger.info("graph-workflow.shared_document_store.legacy_captured", {
      executionId: input.executionId,
      relativePath: input.relativePath,
      contentHash: reference.contentHash,
    });
    return reference;
  }

  return { captureFromWorktree, captureContent, read, migrateLegacyDocument };
}
