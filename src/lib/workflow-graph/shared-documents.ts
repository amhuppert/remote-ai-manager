import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { getErrorMessage } from "@/lib/shared/errors";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";
import {
  createSharedDocumentStore,
  type SharedDocumentStore,
} from "@/lib/workflow-graph/shared-document-store";
import type {
  GraphWorkflowExecution,
  SeededWorkflowDocument,
} from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowSharedDocumentEntry } from "@/lib/workflow-graph/definition-schemas";
const logger = createLogger("graph-workflow-shared-documents");

// Plain literal, not an all-literal path.join: Turbopack resolves that shape
// into a DirAssetReference and walks the directory at build time. Harmless
// here today, but it panics fatally on any symlink leaving the project root —
// see the reserved-path note in agent-backends/codex/managed-skills-bridge.ts.
const SHARED_DOCUMENT_DIRECTORY = ".cc/graph-workflow-docs";

export interface SharedDocumentUpsertInput {
  relativePath: string;
  description: string;
  readWhen: string;
  conversationId?: string;
}

export interface GraphWorkflowSharedDocumentRegistryServiceDeps {
  now(): string;
  createDocumentId(): string;
  /**
   * Copy the just-registered document's content from the registering lane's
   * worktree into the central per-execution store, so it can be materialized
   * into other lane worktrees. Defaults to a no-op; production wires the real
   * {@link createSharedDocumentStore} capture at the composition root.
   */
  captureDocumentContent(input: {
    executionId: string;
    worktreePath: string;
    relativePath: string;
  }): Promise<void>;
}

export type SharedDocumentUpsertOptionalOutcome =
  | { status: "registered"; nextExecution: GraphWorkflowExecution }
  | { status: "skipped_warning"; warning: string };

/**
 * What a pure {@link applyUpsert} merge did, captured as inert data so the
 * observability log can be emitted OUTSIDE the write-queue critical section the
 * merge runs in (`no-slow-work-in-critical-section`).
 */
export interface SharedDocumentMergeOutcome {
  action: "created" | "updated";
  documentId: string;
  relativePath: string;
  description: string;
  readWhen: string;
  conversationId: string | null;
}

/**
 * Emit the shared-document registration log for a completed {@link applyUpsert}.
 * A file write, so it runs only AFTER the finalize mutation commits.
 */
export function logSharedDocumentUpsert(
  executionId: string,
  outcome: SharedDocumentMergeOutcome,
): void {
  const execLogger = getExecutionLogger(executionId);
  if (outcome.action === "updated") {
    execLogger?.lifecycle("shared_document.updated", {
      documentId: outcome.documentId,
      relativePath: outcome.relativePath,
      conversationId: outcome.conversationId,
    });
    logger.info("graph-workflow.shared_document.updated", {
      executionId,
      documentId: outcome.documentId,
      relativePath: outcome.relativePath,
    });
    return;
  }
  execLogger?.lifecycle("shared_document.created", {
    documentId: outcome.documentId,
    relativePath: outcome.relativePath,
    description: outcome.description,
    readWhen: outcome.readWhen,
    conversationId: outcome.conversationId,
  });
  logger.info("graph-workflow.shared_document.created", {
    executionId,
    documentId: outcome.documentId,
    relativePath: outcome.relativePath,
  });
}

const defaultDeps: GraphWorkflowSharedDocumentRegistryServiceDeps = {
  now() {
    return new Date().toISOString();
  },
  createDocumentId() {
    return `doc-${randomUUID()}`;
  },
  async captureDocumentContent() {
    // No-op by default; the composition root injects the real central store.
  },
};

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

export function createGraphWorkflowSharedDocumentRegistryService(
  deps: Partial<GraphWorkflowSharedDocumentRegistryServiceDeps> = {},
) {
  const resolvedDeps = { ...defaultDeps, ...deps };

  function getDirectory(worktreePath: string): string {
    return path.join(worktreePath, SHARED_DOCUMENT_DIRECTORY);
  }

  function list(
    execution: GraphWorkflowExecution,
  ): GraphWorkflowSharedDocumentEntry[] {
    return execution.sharedDocuments;
  }

  /**
   * Pure, synchronous merge of one shared-document entry into a cloned
   * execution — no I/O, no awaits, no logging. This is the only state mutation
   * the upsert performs, so it is the finalize step a staged caller runs inside
   * the write queue (Design 3.1, `no-slow-work-in-critical-section`); the slow
   * content capture and the async path resolution both happen outside the lock,
   * and the registration log ({@link logSharedDocumentUpsert}) is emitted from
   * the returned outcome after the finalize commits.
   */
  function mergeSharedDocumentEntry(input: {
    nextExecution: GraphWorkflowExecution;
    relativePath: string;
    description: string;
    readWhen: string;
    conversationId: string | null;
    now: string;
  }): SharedDocumentMergeOutcome {
    const {
      nextExecution,
      relativePath,
      description,
      readWhen,
      conversationId,
    } = input;
    const existingIndex = nextExecution.sharedDocuments.findIndex(
      (entry) => entry.relativePath === relativePath,
    );

    if (existingIndex >= 0) {
      const existingEntry = nextExecution.sharedDocuments[existingIndex]!;
      if (existingEntry.kind !== "shared") {
        // Engine-owned content: the launching tier wrote it and every lane
        // materializes the central store's copy. Accepting the re-registration
        // would recapture THIS lane's file over it, so one lane could rewrite
        // what every other lane reads as its contract.
        throw new Error(
          `Shared document "${relativePath}" is engine-owned (${existingEntry.kind}) and cannot be re-registered by an agent`,
        );
      }
      nextExecution.sharedDocuments[existingIndex] = {
        ...existingEntry,
        relativePath,
        description,
        readWhen,
        updatedAt: input.now,
        lastUpdatedByConversationId: conversationId,
      };
      return {
        action: "updated",
        documentId: existingEntry.id,
        relativePath,
        description,
        readWhen,
        conversationId,
      };
    }

    const documentId = resolvedDeps.createDocumentId();
    nextExecution.sharedDocuments.push({
      id: documentId,
      relativePath,
      description,
      readWhen,
      kind: "shared",
      createdAt: input.now,
      updatedAt: input.now,
      lastUpdatedByConversationId: conversationId,
    });
    return {
      action: "created",
      documentId,
      relativePath,
      description,
      readWhen,
      conversationId,
    };
  }

  /**
   * Resolve + validate an upsert request into its canonical worktree-relative
   * path, rejecting an escaping/out-of-directory path or an empty
   * description/readWhen exactly as {@link upsert} would. Runs the artifact
   * registry's `register` with a no-op capture registration, so it performs no
   * durable I/O — but it is async by that contract, so a staged caller runs it
   * OUTSIDE the write-queue lock, before the synchronous finalize.
   */
  async function prepareUpsert(
    worktreePath: string,
    input: SharedDocumentUpsertInput,
  ): Promise<{ relativePath: string }> {
    let canonicalRelativePath = input.relativePath;
    const registry = createArtifactRegistry({
      writeFile: async () => {},
      ensureDir: async () => {},
      registration: {
        async registerSharedDocument(reg) {
          canonicalRelativePath = reg.relativePath;
        },
      },
    });
    await registry.register({
      kind: "graph_shared_document",
      worktreePath,
      relativePath: input.relativePath,
      description: input.description,
      readWhen: input.readWhen,
      source: {},
    });
    return { relativePath: canonicalRelativePath };
  }

  /**
   * Best-effort copy of the agent-written file into the central per-execution
   * store so it survives the worktree and reaches other lanes. A missing or
   * unreadable file degrades to a warning — it never throws — so a staged caller
   * can run this slow disk I/O outside the lock and still finalize the
   * registration afterward.
   */
  async function captureContent(input: {
    executionId: string;
    worktreePath: string;
    relativePath: string;
  }): Promise<void> {
    try {
      await resolvedDeps.captureDocumentContent(input);
    } catch (err) {
      logger.warn("graph-workflow.shared_document.capture_failed", {
        executionId: input.executionId,
        relativePath: input.relativePath,
        warning: getErrorMessage(err),
      });
    }
  }

  /**
   * Synchronously apply a resolved upsert to `execution`, returning the next
   * execution with the merged entry plus the inert merge outcome. Pure — no
   * I/O, no logging — so it is safe to run inside the write queue as a staged
   * caller's finalize; the caller emits {@link logSharedDocumentUpsert} from the
   * returned `outcome` after the finalize commits.
   */
  function applyUpsert(
    execution: GraphWorkflowExecution,
    input: {
      relativePath: string;
      description: string;
      readWhen: string;
      conversationId: string | null;
    },
  ): {
    nextExecution: GraphWorkflowExecution;
    outcome: SharedDocumentMergeOutcome;
  } {
    const nextExecution = cloneExecution(execution);
    const outcome = mergeSharedDocumentEntry({
      nextExecution,
      relativePath: input.relativePath,
      description: input.description,
      readWhen: input.readWhen,
      conversationId: input.conversationId,
      now: resolvedDeps.now(),
    });
    return { nextExecution, outcome };
  }

  async function upsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<GraphWorkflowExecution> {
    const { relativePath } = await prepareUpsert(worktreePath, input);
    await captureContent({
      executionId: execution.id,
      worktreePath,
      relativePath,
    });
    const { nextExecution, outcome } = applyUpsert(execution, {
      relativePath,
      description: input.description,
      readWhen: input.readWhen,
      conversationId: input.conversationId ?? null,
    });
    logSharedDocumentUpsert(execution.id, outcome);
    return nextExecution;
  }

  async function upsertOptional(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<SharedDocumentUpsertOptionalOutcome> {
    try {
      const nextExecution = await upsert(worktreePath, execution, input);
      return { status: "registered", nextExecution };
    } catch (err) {
      const warning = getErrorMessage(err);
      logger.warn("graph-workflow.shared_document.optional_skipped", {
        executionId: execution.id,
        relativePath: input.relativePath,
        warning,
      });
      return { status: "skipped_warning", warning };
    }
  }

  return {
    getDirectory,
    list,
    prepareUpsert,
    captureContent,
    applyUpsert,
    logUpsert: logSharedDocumentUpsert,
    upsert,
    upsertOptional,
  };
}

export type { SeededWorkflowDocument };

export interface WorkflowSeededDocumentServiceDeps {
  writeFile(absolutePath: string, contents: string | Uint8Array): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
  /**
   * The central per-execution store. Lane worktrees fork from the committed
   * session branch and `.cc` is git-ignored, so this capture — not the file the
   * seed writes into the session worktree — is what reaches a lane.
   */
  store: SharedDocumentStore;
  now(): string;
  createDocumentId(): string;
}

export interface SeedWorkflowDocumentsInput {
  documents: readonly SeededWorkflowDocument[];
  worktreePath: string;
  execution: GraphWorkflowExecution;
}

export interface WorkflowSeededDocumentService {
  /**
   * The REGISTRATION half: validate each document's path against the worktree
   * confinement rule and register it as a `kind:"seeded"` entry on a clone.
   * Writes nothing, so a launch can commit the complete record — and refuse an
   * escaping path — before it holds the execution lease.
   */
  registerDocuments(
    input: SeedWorkflowDocumentsInput,
  ): Promise<GraphWorkflowExecution>;
  /**
   * The I/O half: write each document into the session worktree and capture it
   * into the central per-execution store. Runs after the launch's reservation
   * commits, and is idempotent — both the write and the capture replace, so a
   * retry over a half-materialized run converges.
   */
  writeDocuments(input: {
    documents: readonly SeededWorkflowDocument[];
    worktreePath: string;
    executionId: string;
  }): Promise<void>;
}

/**
 * Writes engine-seeded documents into the session worktree, captures them into
 * the central store, and registers each as a `kind:"seeded"` shared-document
 * entry — the charter's own two-part mechanism, generalized so any launching
 * tier can seed content without the graph tier knowing what it is.
 *
 * Every failure throws. A run whose seeded document is missing is a run whose
 * agents are pointed at a source of truth that does not exist, which is the
 * failure this seeding exists to prevent; refusing is louder than a warning
 * nobody reads.
 *
 * The seed is split across the launch's lease reservation. Registration runs
 * BEFORE it — so an escaping path refuses the launch with nothing persisted and
 * nothing written — and the file/store writes run AFTER it, so no losing racer
 * can leave bytes in a `.cc` namespace it never won. A write failure is a
 * located halt on the already-reserved run rather than an unwind: the lease is
 * won by then, and a durable halted record is reviewable where a vanished one
 * is not.
 */
export function createWorkflowSeededDocumentService(
  deps: Partial<Omit<WorkflowSeededDocumentServiceDeps, "store">> & {
    store?: SharedDocumentStore;
  } = {},
): WorkflowSeededDocumentService {
  const writeFile =
    deps.writeFile ??
    ((absolutePath, contents) => fs.writeFile(absolutePath, contents));
  const ensureDir =
    deps.ensureDir ??
    (async (absolutePath: string) => {
      await fs.mkdir(absolutePath, { recursive: true });
    });
  const store = deps.store ?? createSharedDocumentStore();
  const now = deps.now ?? (() => new Date().toISOString());
  const createDocumentId =
    deps.createDocumentId ?? (() => `doc-seeded-${randomUUID()}`);

  async function registerDocuments(
    input: SeedWorkflowDocumentsInput,
  ): Promise<GraphWorkflowExecution> {
    if (input.documents.length === 0) {
      return input.execution;
    }

    const nextExecution = cloneExecution(input.execution);
    const timestamp = now();

    for (const document of input.documents) {
      const registry = createArtifactRegistry({
        writeFile,
        ensureDir,
        logger: {
          info: (event, fields) => logger.info(event, fields),
          warn: (event, fields) => logger.warn(event, fields),
          error: (event, fields) => logger.error(event, fields),
        },
        registration: {
          async registerSharedDocument(reg) {
            const existingIndex = nextExecution.sharedDocuments.findIndex(
              (entry) => entry.relativePath === reg.relativePath,
            );
            if (existingIndex >= 0) {
              const existingEntry =
                nextExecution.sharedDocuments[existingIndex]!;
              nextExecution.sharedDocuments[existingIndex] = {
                ...existingEntry,
                relativePath: reg.relativePath,
                description: reg.description,
                readWhen: reg.readWhen,
                kind: "seeded",
                updatedAt: timestamp,
              };
              return;
            }
            nextExecution.sharedDocuments.push({
              id: createDocumentId(),
              relativePath: reg.relativePath,
              description: reg.description,
              readWhen: reg.readWhen,
              kind: "seeded",
              createdAt: timestamp,
              updatedAt: timestamp,
              lastUpdatedByConversationId: null,
            });
          },
        },
      });

      // The artifact registry confines the path to `.cc/graph-workflow-docs`
      // and throws ArtifactRequiredFailure on anything that escapes it, so a
      // launching tier cannot turn a seed into an arbitrary worktree write.
      // Refusing HERE, before the reservation, is what keeps a rejected launch
      // free of both files and rows.
      await registry.register({
        kind: "graph_shared_document",
        worktreePath: input.worktreePath,
        relativePath: document.relativePath,
        description: document.description,
        readWhen: document.readWhen,
        source: { workflowId: nextExecution.id },
      });
    }

    return nextExecution;
  }

  async function writeDocuments(input: {
    documents: readonly SeededWorkflowDocument[];
    worktreePath: string;
    executionId: string;
  }): Promise<void> {
    const registry = createArtifactRegistry({
      writeFile,
      ensureDir,
      logger: {
        info: (event, fields) => logger.info(event, fields),
        warn: (event, fields) => logger.warn(event, fields),
        error: (event, fields) => logger.error(event, fields),
      },
      // Entries are registered by `registerDocuments` and already committed
      // with the execution; this half only puts the bytes on disk and into the
      // central store.
      registration: {
        async registerSharedDocument() {},
      },
    });

    for (const document of input.documents) {
      const record = await registry.write({
        kind: "graph_shared_document",
        worktreePath: input.worktreePath,
        relativePath: document.relativePath,
        contents: document.contents,
        audience: "user_facing",
        description: document.description,
        readWhen: document.readWhen,
        source: { workflowId: input.executionId },
      });

      // Lane worktrees fork from the committed session branch and `.cc` is
      // git-ignored, so this capture — not the worktree file — is what reaches
      // a lane.
      await store.captureFromWorktree({
        executionId: input.executionId,
        worktreePath: input.worktreePath,
        relativePath: record.relativePath,
      });

      getExecutionLogger(input.executionId)?.lifecycle(
        "shared_document.seeded",
        {
          relativePath: record.relativePath,
          description: document.description,
          bytes: document.contents.length,
        },
      );
      logger.info("graph-workflow.shared_document.seeded", {
        executionId: input.executionId,
        relativePath: record.relativePath,
        bytes: document.contents.length,
      });
    }
  }

  return { registerDocuments, writeDocuments };
}
