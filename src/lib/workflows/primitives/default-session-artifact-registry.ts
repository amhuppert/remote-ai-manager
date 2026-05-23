/**
 * Default session-scoped ArtifactRegistry factory.
 *
 * Wires the shared ArtifactRegistry primitive to the existing CC discoverability
 * systems for a specific (project, session):
 *
 *  - `reference_document` and `focus_memory` kinds register through the project
 *    state's reference-document store via `createReferenceDocument`.
 *  - `codex_output` and `validation_log` kinds are filesystem-only (no
 *    discoverability registration), preserving today's behavior.
 *  - `graph_shared_document` registration is intentionally not wired by default
 *    here: it requires the owning graph workflow execution context (the
 *    shared-document service mutates the execution rather than performing a
 *    side effect). Graph workflow code should compose the shared-document
 *    registry with `createArtifactRegistry` directly when it needs that wiring.
 */
import fs from "node:fs/promises";
import { createLogger } from "@/lib/logging";
import {
  createArtifactRegistry,
  type ArtifactRegistry,
  type ArtifactRegistration,
} from "./artifact-registry";

const logger = createLogger("session-artifact-registry");

export interface ReferenceDocumentRegistrarFn {
  (input: {
    projectPath: string;
    sessionName: string;
    filePath: string;
    description: string;
  }): Promise<unknown>;
}

export interface DefaultSessionArtifactRegistryDeps {
  projectPath: string;
  sessionName: string;
  registerReferenceDocument: ReferenceDocumentRegistrarFn;
  writeFile?: (
    absolutePath: string,
    contents: string | Uint8Array,
  ) => Promise<void>;
  ensureDir?: (absolutePath: string) => Promise<void>;
  now?: () => string;
  newId?: () => string;
}

async function defaultWriteFile(
  absolutePath: string,
  contents: string | Uint8Array,
): Promise<void> {
  await fs.writeFile(absolutePath, contents);
}

async function defaultEnsureDir(absolutePath: string): Promise<void> {
  await fs.mkdir(absolutePath, { recursive: true });
}

export function createDefaultSessionArtifactRegistry(
  deps: DefaultSessionArtifactRegistryDeps,
): ArtifactRegistry {
  const registration: ArtifactRegistration = {
    async registerReferenceDocument(input) {
      await deps.registerReferenceDocument({
        projectPath: deps.projectPath,
        sessionName: deps.sessionName,
        filePath: input.relativePath,
        description: input.description,
      });
    },
  };

  return createArtifactRegistry({
    writeFile: deps.writeFile ?? defaultWriteFile,
    ensureDir: deps.ensureDir ?? defaultEnsureDir,
    registration,
    logger: {
      info: (event, fields) => logger.info(event, fields),
      warn: (event, fields) => logger.warn(event, fields),
      error: (event, fields) => logger.error(event, fields),
    },
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
  });
}

/**
 * Convenience helper that resolves the project state's `createReferenceDocument`
 * function lazily to avoid bootstrapping the state module before first use.
 */
function getDefaultReferenceDocumentRegistrar(): ReferenceDocumentRegistrarFn {
  return async (input) => {
    const stateModule: {
      createReferenceDocument: (
        projectPath: string,
        sessionName: string,
        filePath: string,
        description: string,
      ) => Promise<unknown>;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
    } = require("@/lib/state");
    return stateModule.createReferenceDocument(
      input.projectPath,
      input.sessionName,
      input.filePath,
      input.description,
    );
  };
}

export function createSessionArtifactRegistryForProduction(input: {
  projectPath: string;
  sessionName: string;
}): ArtifactRegistry {
  return createDefaultSessionArtifactRegistry({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    registerReferenceDocument: getDefaultReferenceDocumentRegistrar(),
  });
}
