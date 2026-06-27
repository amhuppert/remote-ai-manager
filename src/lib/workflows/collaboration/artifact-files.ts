import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  CollaborationAgentArtifactPhase,
  CollaborationArtifact,
  CollaborationFlowAgent,
  CollaborationGeneratedArtifact,
} from "./types";

const logger = createLogger("workflows.collaboration.artifact-files");

const MAX_ARTIFACT_BYTES = 512 * 1024;

export type CollaborationArtifactPhase = CollaborationAgentArtifactPhase;

export type ArtifactFileValidationOutcome =
  | { success: true; value: undefined }
  | { success: false; error: string };

export interface CollaborationArtifactFileContext {
  workflowId: string;
  round: number;
  agent: CollaborationFlowAgent;
  phase: CollaborationArtifactPhase;
}

export interface ValidateGeneratedArtifactFilesInput {
  worktreePath: string;
  workflowId: string;
  artifact: CollaborationArtifact;
}

export function collaborationArtifactDir(
  input: CollaborationArtifactFileContext,
): string {
  return path.posix.join(
    "memory-bank",
    "collaboration",
    input.workflowId,
    `round-${input.round}`,
    input.agent,
    input.phase,
  );
}

export function collaborationArtifactFilePath(
  input: CollaborationArtifactFileContext,
  fileName: string,
): string {
  return path.posix.join(collaborationArtifactDir(input), fileName);
}

export function requiredArtifactFileRefs(
  input: CollaborationArtifactFileContext,
): CollaborationGeneratedArtifact[] {
  if (input.phase === "final_answer") {
    return [
      {
        id: "answer",
        artifact_type: "main_response",
        path: collaborationArtifactFilePath(input, "answer.md"),
        round: input.round,
        agent: input.agent,
        phase: input.phase,
        summary: "Final answer.",
      },
      {
        id: "audit",
        artifact_type: "audit",
        path: collaborationArtifactFilePath(input, "audit.md"),
        round: input.round,
        agent: input.agent,
        phase: input.phase,
        summary: "Final answer audit.",
      },
    ];
  }

  return [
    {
      id: "main",
      artifact_type: "main_response",
      path: collaborationArtifactFilePath(input, "main.md"),
      round: input.round,
      agent: input.agent,
      phase: input.phase,
      summary: `Full ${input.phase} response.`,
    },
  ];
}

function artifactHasFileRefs(
  artifact: CollaborationArtifact,
): artifact is CollaborationArtifact & {
  artifacts: CollaborationGeneratedArtifact[];
  agent: CollaborationFlowAgent;
  round: number;
  kind: CollaborationArtifactPhase;
} {
  return artifact.kind !== "open_conflicts";
}

function validateRefPath(input: {
  workflowId: string;
  artifact: {
    round: number;
    agent: CollaborationFlowAgent;
    kind: CollaborationArtifactPhase;
  };
  ref: CollaborationGeneratedArtifact;
}): string | null {
  const refPath = input.ref.path;
  if (path.posix.isAbsolute(refPath)) return "path must be relative";
  if (refPath.includes("\\")) return "path must use POSIX separators";
  if (!refPath.endsWith(".md")) return "path must end with .md";
  if (path.posix.normalize(refPath) !== refPath) {
    return "path must not contain traversal segments";
  }

  const expectedPrefix =
    collaborationArtifactDir({
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
    }) + "/";
  if (!refPath.startsWith(expectedPrefix)) {
    return `path must stay under ${expectedPrefix}`;
  }
  if (
    input.ref.round !== input.artifact.round ||
    input.ref.agent !== input.artifact.agent ||
    input.ref.phase !== input.artifact.kind
  ) {
    return "artifact ref metadata must match parent artifact";
  }
  return null;
}

async function validateOneFile(input: {
  worktreePath: string;
  workflowId: string;
  artifact: {
    round: number;
    agent: CollaborationFlowAgent;
    kind: CollaborationArtifactPhase;
  };
  ref: CollaborationGeneratedArtifact;
}): Promise<ArtifactFileValidationOutcome> {
  const pathError = validateRefPath(input);
  if (pathError) {
    logger.warn("collaboration.artifact_files.validation_failed", {
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
      path: input.ref.path,
      error: pathError,
    });
    return { success: false, error: `${input.ref.path}: ${pathError}` };
  }

  const absolutePath = path.join(input.worktreePath, input.ref.path);
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(absolutePath);
  } catch (err) {
    const error = getErrorMessage(err);
    logger.warn("collaboration.artifact_files.validation_failed", {
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
      path: input.ref.path,
      error,
    });
    return { success: false, error: `${input.ref.path}: ${error}` };
  }

  if (!fileStat.isFile()) {
    const error = "path is not a file";
    logger.warn("collaboration.artifact_files.validation_failed", {
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
      path: input.ref.path,
      error,
    });
    return { success: false, error: `${input.ref.path}: ${error}` };
  }

  if (fileStat.size > MAX_ARTIFACT_BYTES) {
    const error = `file exceeds ${MAX_ARTIFACT_BYTES} bytes`;
    logger.warn("collaboration.artifact_files.validation_failed", {
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
      path: input.ref.path,
      error,
    });
    return { success: false, error: `${input.ref.path}: ${error}` };
  }

  const content = await readFile(absolutePath, "utf-8");
  if (content.trim().length === 0) {
    const error = "file is empty";
    logger.warn("collaboration.artifact_files.validation_failed", {
      workflowId: input.workflowId,
      round: input.artifact.round,
      agent: input.artifact.agent,
      phase: input.artifact.kind,
      path: input.ref.path,
      error,
    });
    return { success: false, error: `${input.ref.path}: ${error}` };
  }

  logger.debug("collaboration.artifact_files.validated", {
    workflowId: input.workflowId,
    round: input.artifact.round,
    agent: input.artifact.agent,
    phase: input.artifact.kind,
    path: input.ref.path,
  });
  return { success: true, value: undefined };
}

export async function validateGeneratedArtifactFiles(
  input: ValidateGeneratedArtifactFilesInput,
): Promise<ArtifactFileValidationOutcome> {
  if (!artifactHasFileRefs(input.artifact)) {
    return { success: true, value: undefined };
  }

  for (const ref of input.artifact.artifacts) {
    const result = await validateOneFile({
      worktreePath: input.worktreePath,
      workflowId: input.workflowId,
      artifact: input.artifact,
      ref,
    });
    if (!result.success) return result;
  }

  return { success: true, value: undefined };
}

export function findGeneratedArtifactRef(
  artifact: CollaborationArtifact,
  id: string,
): CollaborationGeneratedArtifact | null {
  if (!artifactHasFileRefs(artifact)) return null;
  return artifact.artifacts.find((ref) => ref.id === id) ?? null;
}

function validateReadableRelativePath(
  ref: CollaborationGeneratedArtifact,
): { success: true } | { success: false; error: string } {
  if (path.posix.isAbsolute(ref.path)) {
    return { success: false, error: "path must be relative" };
  }
  if (ref.path.includes("\\")) {
    return { success: false, error: "path must use POSIX separators" };
  }
  if (path.posix.normalize(ref.path) !== ref.path) {
    return {
      success: false,
      error: "path must not contain traversal segments",
    };
  }
  if (!ref.path.endsWith(".md")) {
    return { success: false, error: "path must end with .md" };
  }
  return { success: true };
}

export async function readGeneratedArtifactFile(
  worktreePath: string,
  ref: CollaborationGeneratedArtifact,
): Promise<string> {
  const validation = validateReadableRelativePath(ref);
  if (!validation.success) {
    logger.warn("collaboration.artifact_files.read_failed", {
      path: ref.path,
      error: validation.error,
    });
    throw new Error(`${ref.path}: ${validation.error}`);
  }

  try {
    const content = await readFile(path.join(worktreePath, ref.path), "utf-8");
    logger.debug("collaboration.artifact_files.read", { path: ref.path });
    return content;
  } catch (err) {
    logger.warn("collaboration.artifact_files.read_failed", {
      path: ref.path,
      error: getErrorMessage(err),
    });
    throw err;
  }
}
