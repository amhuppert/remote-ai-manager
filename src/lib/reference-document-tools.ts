import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  createReferenceDocument as createReferenceDocumentDefault,
  deleteReferenceDocument as deleteReferenceDocumentDefault,
  getReferenceDocuments as getReferenceDocumentsDefault,
} from "@/lib/state";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import type { ReferenceDocument } from "@/types";
import path from "node:path";
import { unlink } from "node:fs/promises";

const logger = createLogger("reference-document-tools");

export interface ReferenceDocumentToolContext {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
}

export interface ReferenceDocumentToolDeps {
  createReferenceDocument(
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ): Promise<ReferenceDocument>;
  deleteReferenceDocument(
    projectPath: string,
    sessionName: string,
    documentId: string,
  ): Promise<ReferenceDocument | null>;
  getReferenceDocuments(
    projectPath: string,
    sessionName: string,
  ): Promise<ReferenceDocument[]>;
  deleteFile(filePath: string): Promise<void>;
}

async function defaultDeleteFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export const defaultReferenceDocumentToolDeps: ReferenceDocumentToolDeps = {
  createReferenceDocument: createReferenceDocumentDefault,
  deleteReferenceDocument: deleteReferenceDocumentDefault,
  getReferenceDocuments: getReferenceDocumentsDefault,
  deleteFile: defaultDeleteFile,
};

export function createReferenceDocumentToolServer(
  context: ReferenceDocumentToolContext,
  deps: ReferenceDocumentToolDeps = defaultReferenceDocumentToolDeps,
): McpSdkServerConfigWithInstance {
  const { projectPath, sessionName, worktreePath } = context;

  return createSdkMcpServer({
    name: "reference-document-tools",
    version: "1.0.0",
    tools: [
      tool(
        "register_document",
        "Register a file as a reference document for this session. Other conversations will see it in their system prompt. If the file path is already registered, updates the description.",
        {
          file_path: z
            .string()
            .min(1)
            .describe("Path to the file to register as a reference document"),
          description: z
            .string()
            .min(1)
            .describe(
              "Describes when and why agents should read this document",
            ),
        },
        async (args) => {
          try {
            const doc = await deps.createReferenceDocument(
              projectPath,
              sessionName,
              args.file_path,
              args.description,
            );

            logger.info("tool.register_document", {
              docId: doc.id,
              filePath: doc.filePath,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Reference document registered: ${doc.filePath}`,
                },
              ],
            };
          } catch (error) {
            logger.error("tool.register_document.error", {
              error: getErrorMessage(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to register document: ${getErrorMessage(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        "list_documents",
        "List all registered reference documents for this session.",
        {},
        async () => {
          try {
            const docs = await deps.getReferenceDocuments(
              projectPath,
              sessionName,
            );

            if (docs.length === 0) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "No reference documents registered for this session.",
                  },
                ],
              };
            }

            const lines = [
              `Reference documents (${docs.length}):`,
              ...docs.map(
                (d) => `- **${d.filePath}** (ID: ${d.id}): ${d.description}`,
              ),
            ];

            return {
              content: [
                {
                  type: "text" as const,
                  text: lines.join("\n"),
                },
              ],
            };
          } catch (error) {
            logger.error("tool.list_documents.error", {
              error: getErrorMessage(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to list documents: ${getErrorMessage(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),

      tool(
        "delete_document",
        "Delete a reference document by its ID. Removes the metadata and deletes the file from disk.",
        {
          document_id: z
            .string()
            .min(1)
            .describe("ID of the reference document to delete"),
        },
        async (args) => {
          try {
            const removed = await deps.deleteReferenceDocument(
              projectPath,
              sessionName,
              args.document_id,
            );

            if (!removed) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Document "${args.document_id}" not found.`,
                  },
                ],
                isError: true,
              };
            }

            const resolvedPath = path.isAbsolute(removed.filePath)
              ? removed.filePath
              : path.join(worktreePath, removed.filePath);
            await deps.deleteFile(resolvedPath);

            logger.info("tool.delete_document", {
              docId: removed.id,
              filePath: removed.filePath,
            });

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Reference document ${removed.id} deleted (${removed.filePath}).`,
                },
              ],
            };
          } catch (error) {
            logger.error("tool.delete_document.error", {
              error: getErrorMessage(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to delete document: ${getErrorMessage(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
