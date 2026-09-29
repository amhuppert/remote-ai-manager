import { mkdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import { isInsideLanePath, toLanePathSegment } from "./lane-path-segments";

export interface ValidatorWorkspace {
  worktreePath: string;
  scratchDirectory: string;
}

export interface PrepareValidatorWorkspaceInput {
  executionId: string;
  contextId: string;
  assignmentId: string;
  worktreePath: string;
}

/**
 * Validators start in the candidate, with assignment-private scratch beneath
 * .cc/temp. Provider sandboxes make cwd writable, so graph validators receive
 * instruction-only write limits rather than an envelope that relocates cwd.
 */
export function prepareValidatorWorkspace(
  input: PrepareValidatorWorkspaceInput,
): ValidatorWorkspace {
  try {
    const worktreePath = realpathSync(input.worktreePath);
    const scratchRoot = path.join(worktreePath, ".cc", "temp");
    const rawScratch = path.join(
      scratchRoot,
      "validators",
      toLanePathSegment(input.executionId),
      toLanePathSegment(input.contextId),
      toLanePathSegment(input.assignmentId),
    );
    mkdirSync(rawScratch, { recursive: true });
    const scratchDirectory = realpathSync(rawScratch);
    if (!isInsideLanePath(scratchRoot, scratchDirectory)) {
      throw new Error(`scratch directory escapes ${scratchRoot}`);
    }
    return { worktreePath, scratchDirectory };
  } catch (error) {
    throw new Error(
      `Cannot prepare the validator workspace: ${getErrorMessage(error)}`,
    );
  }
}
