import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { atomicWriteFile } from "@/lib/shared/atomic-write-json";
import { renderCharterDocument } from "./charter/render";
import type { SharedDocumentStore } from "./shared-document-store";
import type { GraphWorkflowExecution } from "@/lib/workflow-graph/schemas";

const logger = createLogger("graph-workflow-document-materialization");

/**
 * Writes the execution's registered alignment documents into a target lane
 * worktree so the agent running there can read them regardless of commit
 * state. Charter content is rendered from the execution's immutable charter
 * snapshot; shared-document content is pulled from the central
 * {@link SharedDocumentStore}. Call this before an agent iteration in any
 * execution target, including the session worktree.
 *
 * The store holds the latest *registered* version of each shared document and
 * is the source of truth: re-materializing overwrites the worktree copy. An
 * agent that edits a shared document must re-register it (the registration
 * recaptures content) for the change to survive the next materialization and
 * reach other lanes.
 */
export interface WorkflowDocumentMaterializerDeps {
  store: SharedDocumentStore;
  writeFile(absolutePath: string, contents: string): Promise<void>;
  ensureDir(absolutePath: string): Promise<void>;
}

export interface MaterializeInput {
  execution: GraphWorkflowExecution;
  worktreePath: string;
}

export interface MaterializeResult {
  charterWritten: boolean;
  sharedWritten: number;
  /** Registered shared documents with no captured content in the store. */
  missing: string[];
}

export interface WorkflowDocumentMaterializer {
  materialize(input: MaterializeInput): Promise<MaterializeResult>;
}

export function createWorkflowDocumentMaterializer(
  depsInput: { store: SharedDocumentStore } & Partial<
    Omit<WorkflowDocumentMaterializerDeps, "store">
  >,
): WorkflowDocumentMaterializer {
  const deps: WorkflowDocumentMaterializerDeps = {
    store: depsInput.store,
    writeFile: depsInput.writeFile ?? atomicWriteFile,
    ensureDir:
      depsInput.ensureDir ??
      (async (absolutePath) => {
        await mkdir(absolutePath, { recursive: true });
      }),
  };

  async function writeInto(
    worktreePath: string,
    relativePath: string,
    contents: string,
  ): Promise<void> {
    const dest = path.join(worktreePath, relativePath);
    await deps.ensureDir(path.dirname(dest));
    await deps.writeFile(dest, contents);
  }

  async function materialize(
    input: MaterializeInput,
  ): Promise<MaterializeResult> {
    const { execution, worktreePath } = input;
    let charterWritten = false;
    let sharedWritten = 0;
    const missing: string[] = [];

    for (const entry of execution.sharedDocuments) {
      if (entry.kind === "charter") {
        await writeInto(
          worktreePath,
          entry.relativePath,
          renderCharterDocument(execution.charter, execution.charterAmendments),
        );
        charterWritten = true;
        continue;
      }

      const content = await deps.store.read({
        executionId: execution.id,
        relativePath: entry.relativePath,
        contentHash: entry.contentHash,
      });
      if (content === null) {
        missing.push(entry.relativePath);
        continue;
      }
      await writeInto(worktreePath, entry.relativePath, content);
      sharedWritten += 1;
    }

    if (missing.length > 0) {
      logger.warn("graph-workflow.documents.materialize_missing", {
        executionId: execution.id,
        worktreePath,
        missing,
      });
      throw new Error(
        `Registered document content unavailable: ${missing.join(", ")}`,
      );
    }
    logger.info("graph-workflow.documents.materialized", {
      executionId: execution.id,
      worktreePath,
      charterWritten,
      sharedWritten,
      missingCount: missing.length,
    });

    return { charterWritten, sharedWritten, missing };
  }

  return { materialize };
}
