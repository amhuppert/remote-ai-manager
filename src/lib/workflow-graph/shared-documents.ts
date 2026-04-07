import { randomUUID } from "node:crypto";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getExecutionLogger } from "@/lib/workflow-graph/execution-logger";
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

function cloneExecution(
  execution: GraphWorkflowExecution,
): GraphWorkflowExecution {
  return structuredClone(execution);
}

function isPathInsideDirectory(
  worktreePath: string,
  relativePath: string,
): boolean {
  const knownDirectory = path.resolve(worktreePath, SHARED_DOCUMENT_DIRECTORY);
  const resolvedPath = path.resolve(worktreePath, relativePath);
  const relativeToDirectory = path.relative(knownDirectory, resolvedPath);

  return (
    relativeToDirectory !== ".." &&
    !relativeToDirectory.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativeToDirectory)
  );
}

function normalizeRelativePath(
  worktreePath: string,
  relativePath: string,
): string {
  return path.relative(worktreePath, path.resolve(worktreePath, relativePath));
}

const defaultDeps: GraphWorkflowSharedDocumentRegistryServiceDeps = {
  now() {
    return new Date().toISOString();
  },
  createDocumentId() {
    return `doc-${randomUUID()}`;
  },
};

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

  function upsert(
    worktreePath: string,
    execution: GraphWorkflowExecution,
    input: SharedDocumentUpsertInput,
  ): GraphWorkflowExecution {
    if (!isPathInsideDirectory(worktreePath, input.relativePath)) {
      throw new Error(
        "Shared documents must be registered inside .cc/graph-workflow-docs/",
      );
    }

    const nextExecution = cloneExecution(execution);
    const now = resolvedDeps.now();
    const normalizedRelativePath = normalizeRelativePath(
      worktreePath,
      input.relativePath,
    );
    const existingIndex = nextExecution.sharedDocuments.findIndex(
      (entry) =>
        normalizeRelativePath(worktreePath, entry.relativePath) ===
        normalizedRelativePath,
    );

    const execLogger = getExecutionLogger(execution.id);

    if (existingIndex >= 0) {
      const existingEntry = nextExecution.sharedDocuments[existingIndex]!;
      nextExecution.sharedDocuments[existingIndex] = {
        ...existingEntry,
        relativePath: normalizedRelativePath,
        description: input.description,
        readWhen: input.readWhen,
        updatedAt: now,
        lastUpdatedByConversationId: input.conversationId ?? null,
      };

      execLogger?.lifecycle("shared_document.updated", {
        documentId: existingEntry.id,
        relativePath: normalizedRelativePath,
        conversationId: input.conversationId ?? null,
      });
      logger.info("graph-workflow.shared_document.updated", {
        executionId: execution.id,
        documentId: existingEntry.id,
        relativePath: normalizedRelativePath,
      });

      return nextExecution;
    }

    const documentId = resolvedDeps.createDocumentId();
    nextExecution.sharedDocuments.push({
      id: documentId,
      relativePath: normalizedRelativePath,
      description: input.description,
      readWhen: input.readWhen,
      createdAt: now,
      updatedAt: now,
      lastUpdatedByConversationId: input.conversationId ?? null,
    });

    execLogger?.lifecycle("shared_document.created", {
      documentId,
      relativePath: normalizedRelativePath,
      description: input.description,
      readWhen: input.readWhen,
      conversationId: input.conversationId ?? null,
    });
    logger.info("graph-workflow.shared_document.created", {
      executionId: execution.id,
      documentId,
      relativePath: normalizedRelativePath,
    });

    return nextExecution;
  }

  return {
    getDirectory,
    list,
    upsert,
  };
}
