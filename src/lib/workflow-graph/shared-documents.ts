import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
import {
  createArtifactRegistry,
  type ArtifactRegistry,
} from "@/lib/workflows/primitives/artifact-registry";
import type {
  GraphWorkflowExecution,
  GraphWorkflowSharedDocumentEntry,
} from "@/types";

const logger = createLogger("graph-workflow-shared-documents");

export const SHARED_DOCUMENT_DIRECTORY = path.join(
  ".cc",
  "graph-workflow-docs",
);

export interface SharedDocumentUpsertInput {
  relativePath: string;
  description: string;
  readWhen: string;
  conversationId?: string;
}

export interface GraphWorkflowSharedDocumentRegistryServiceDeps {
  now(): string;
  createDocumentId(): string;
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

    await registry.register({
      kind: "graph_shared_document",
      worktreePath,
      relativePath: input.relativePath,
      description: input.description,
      readWhen: input.readWhen,
      source: { workflowId: execution.id },
    });

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
      const warning = err instanceof Error ? err.message : String(err);
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
