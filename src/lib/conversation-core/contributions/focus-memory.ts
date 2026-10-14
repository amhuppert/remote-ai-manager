/**
 * Pre-turn step: focus-memory artifact registration.
 *
 * Runs during backend-runtime creation so `memory-bank/focus.md` is a
 * registered reference document before the session instructions that list
 * reference documents are assembled.
 */

import fs from "node:fs/promises";
import { createArtifactRegistry } from "@/lib/workflows/primitives/artifact-registry";

const FOCUS_MEMORY_DESCRIPTION =
  "Current work-in-progress and remaining tasks for this session";

export interface RegisterFocusMemoryIfPresentInput {
  worktreePath: string;
  projectPath: string;
  sessionName: string;
  conversationId: string;
  fileExists: (filePath: string) => boolean;
  registerReferenceDocument: (
    projectPath: string,
    sessionName: string,
    filePath: string,
    description: string,
  ) => Promise<unknown>;
  /** Optional registry override; production constructs one if omitted. */
  artifactRegistry?: ReturnType<typeof createArtifactRegistry>;
}

/**
 * Register `memory-bank/focus.md` as a `focus_memory` artifact when present.
 *
 * Always routes through the shared `ArtifactRegistry.register()` flow so the
 * canonical path is enforced and shallow source metadata (workflowId =
 * conversationId) is recorded alongside the existing reference-document
 * registration. Preserves the prior behavior of doing nothing when the file
 * is absent.
 */
export async function registerFocusMemoryIfPresent(
  input: RegisterFocusMemoryIfPresentInput,
): Promise<void> {
  const focusPath = `${input.worktreePath}/memory-bank/focus.md`;
  if (!input.fileExists(focusPath)) return;

  const registry =
    input.artifactRegistry ??
    createArtifactRegistry({
      writeFile: (absolutePath, contents) =>
        fs.writeFile(absolutePath, contents),
      ensureDir: (absolutePath) =>
        fs.mkdir(absolutePath, { recursive: true }).then(() => {}),
      registration: {
        registerReferenceDocument: async ({ relativePath, description }) => {
          await input.registerReferenceDocument(
            input.projectPath,
            input.sessionName,
            relativePath,
            description,
          );
        },
      },
    });

  await registry.register({
    kind: "focus_memory",
    worktreePath: input.worktreePath,
    relativePath: "memory-bank/focus.md",
    description: FOCUS_MEMORY_DESCRIPTION,
    source: { workflowId: input.conversationId },
  });
}
