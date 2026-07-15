import { randomUUID } from "node:crypto";
import { getErrorMessage } from "@/lib/shared/errors";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createArtifactRegistry,
  type ArtifactRegistry,
} from "@/lib/workflows/primitives/artifact-registry";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";
import type { GraphWorkflowSharedDocumentEntry } from "@/lib/workflow-graph/definition-schemas";
const logger = createLogger("graph-workflow-shared-documents");

const SHARED_DOCUMENT_DIRECTORY = path.join(".cc", "graph-workflow-docs");

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

  function buildExecutionMutationRegistry(input: {
    nextExecution: GraphWorkflowExecution;
    conversationId: string | null;
    now: string;
  }): ArtifactRegistry {
    const { nextExecution, conversationId, now } = input;
    const execLogger = getExecutionLogger(nextExecution.id);

    return createArtifactRegistry({
      writeFile: async () => {},
      ensureDir: async () => {},
      registration: {
        async registerSharedDocument(reg) {
          const normalizedRelativePath = reg.relativePath;
          const existingIndex = nextExecution.sharedDocuments.findIndex(
            (entry) => entry.relativePath === normalizedRelativePath,
          );

          if (existingIndex >= 0) {
            const existingEntry = nextExecution.sharedDocuments[existingIndex]!;
            nextExecution.sharedDocuments[existingIndex] = {
              ...existingEntry,
              relativePath: normalizedRelativePath,
              description: reg.description,
              readWhen: reg.readWhen,
              updatedAt: now,
              lastUpdatedByConversationId: conversationId,
            };

            execLogger?.lifecycle("shared_document.updated", {
              documentId: existingEntry.id,
              relativePath: normalizedRelativePath,
              conversationId,
            });
            logger.info("graph-workflow.shared_document.updated", {
              executionId: nextExecution.id,
              documentId: existingEntry.id,
              relativePath: normalizedRelativePath,
            });
            return;
          }

          const documentId = resolvedDeps.createDocumentId();
          nextExecution.sharedDocuments.push({
            id: documentId,
            relativePath: normalizedRelativePath,
            description: reg.description,
            readWhen: reg.readWhen,
            kind: "shared",
            createdAt: now,
            updatedAt: now,
            lastUpdatedByConversationId: conversationId,
          });

          execLogger?.lifecycle("shared_document.created", {
            documentId,
            relativePath: normalizedRelativePath,
            description: reg.description,
            readWhen: reg.readWhen,
            conversationId,
          });
          logger.info("graph-workflow.shared_document.created", {
            executionId: nextExecution.id,
            documentId,
            relativePath: normalizedRelativePath,
          });
        },
      },
    });
  }

  async function performUpsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<GraphWorkflowExecution> {
    const nextExecution = cloneExecution(execution);
    const registry = buildExecutionMutationRegistry({
      nextExecution,
      conversationId: input.conversationId ?? null,
      now: resolvedDeps.now(),
    });

    const record = await registry.register({
      kind: "graph_shared_document",
      worktreePath,
      relativePath: input.relativePath,
      description: input.description,
      readWhen: input.readWhen,
      source: { workflowId: execution.id },
    });

    // Best-effort: capture the agent-written file into the central store so it
    // survives the worktree and reaches other lanes. A missing/unreadable file
    // (e.g. the agent registered a path it never wrote) degrades to a warning
    // rather than failing the registration.
    try {
      await resolvedDeps.captureDocumentContent({
        executionId: nextExecution.id,
        worktreePath,
        relativePath: record.relativePath,
      });
    } catch (err) {
      logger.warn("graph-workflow.shared_document.capture_failed", {
        executionId: nextExecution.id,
        relativePath: record.relativePath,
        warning: getErrorMessage(err),
      });
    }

    return nextExecution;
  }

  async function upsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<GraphWorkflowExecution> {
    return performUpsert(worktreePath, execution, input);
  }

  async function upsertOptional(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): Promise<SharedDocumentUpsertOptionalOutcome> {
    try {
      const nextExecution = await performUpsert(worktreePath, execution, input);
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
    upsert,
    upsertOptional,
  };
}
