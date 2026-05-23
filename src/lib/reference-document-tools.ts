import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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

const defaultReferenceDocumentToolDeps: ReferenceDocumentToolDeps = {
  createReferenceDocument: createReferenceDocumentDefault,
  deleteReferenceDocument: deleteReferenceDocumentDefault,
  getReferenceDocuments: getReferenceDocumentsDefault,
  deleteFile: defaultDeleteFile,
};

const registerDocumentInputSchema = {
  file_path: z
    .string()
    .min(1)
    .describe("Path to the file to register as a reference document"),
  description: z
    .string()
    .min(1)
    .describe("Describes when and why agents should read this document"),
};

const deleteDocumentInputSchema = {
  document_id: z
    .string()
    .min(1)
    .describe("ID of the reference document to delete"),
};

function createRegisterDocumentHandler(
  context: ReferenceDocumentToolContext,
  deps: ReferenceDocumentToolDeps,
) {
  return async (args: { file_path: string; description: string }) => {
    try {
      const doc = await deps.createReferenceDocument(
        context.projectPath,
        context.sessionName,
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
  };
}

function createListDocumentsHandler(
  context: ReferenceDocumentToolContext,
  deps: ReferenceDocumentToolDeps,
) {
  return async () => {
    try {
      const docs = await deps.getReferenceDocuments(
        context.projectPath,
        context.sessionName,
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
  };
}

function createDeleteDocumentHandler(
  context: ReferenceDocumentToolContext,
  deps: ReferenceDocumentToolDeps,
) {
  return async (args: { document_id: string }) => {
    try {
      const removed = await deps.deleteReferenceDocument(
        context.projectPath,
        context.sessionName,
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
        : path.join(context.worktreePath, removed.filePath);
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
  };
}

export function registerReferenceDocumentTools(
  server: McpServer,
  context: ReferenceDocumentToolContext,
  deps: ReferenceDocumentToolDeps = defaultReferenceDocumentToolDeps,
): void {
  server.registerTool(
    "register_document",
    {
      description:
        "Register a file as a reference document for this session. Other conversations will see it in their system prompt. If the file path is already registered, updates the description.",
      inputSchema: registerDocumentInputSchema,
    },
    createRegisterDocumentHandler(context, deps),
  );

  server.registerTool(
    "list_documents",
    {
      description: "List all registered reference documents for this session.",
      inputSchema: {},
    },
    createListDocumentsHandler(context, deps),
  );

  server.registerTool(
    "delete_document",
    {
      description:
        "Delete a reference document by its ID. Removes the metadata and deletes the file from disk.",
      inputSchema: deleteDocumentInputSchema,
    },
    createDeleteDocumentHandler(context, deps),
  );
}
