import { fromPromise } from "xstate";
import { squashMerge } from "@/lib/git/worktree";
import { acquireProjectLock } from "@/lib/prompt/single-flight";
import { createLogger } from "@/lib/logging";
import type {
  SquashMergeInput,
  SquashMergeOutput,
} from "@/lib/workflows/merge/actors";

const logger = createLogger("graph-workflow-graph-squash-merge");

const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_RETRY_MS = 100;

export interface GraphContextSquashMergeDeps {
  squashMerge: (
    mergePath: string,
    branchName: string,
    message: string,
    targetBranch: string,
  ) => Promise<{ mergeHash: string }>;
  acquireProjectLock: (projectPath: string) => () => void;
  maxWaitMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Graph fan-in squash variant. Mirrors the project-lock acquisition loop of
 * the default squashMergeActor but does NOT invoke setSessionFinished,
 * stopAllForSession, or retargetOrphanedChildren — those side effects belong
 * to the user-driven session lifecycle, not graph context fan-in.
 */
export async function runGraphContextSquashMerge(
  deps: GraphContextSquashMergeDeps,
  input: SquashMergeInput,
): Promise<SquashMergeOutput> {
  const maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const sleep = deps.sleep ?? defaultSleep;

  let release: (() => void) | undefined;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    try {
      release = deps.acquireProjectLock(input.projectPath);
      break;
    } catch {
      await sleep(retryMs);
    }
  }

  if (!release) {
    logger.warn("project_lock_timeout", {
      projectPath: input.projectPath,
      branchName: input.branchName,
      maxWaitMs,
    });
    throw new Error(
      "Another merge is in progress for this project. Please retry.",
    );
  }

  try {
    const mergePath = input.targetWorktreePath ?? input.projectPath;
    logger.debug("squash_start", {
      mergePath,
      branchName: input.branchName,
      targetBranch: input.targetBranch,
    });
    const { mergeHash } = await deps.squashMerge(
      mergePath,
      input.branchName,
      input.message,
      input.targetBranch,
    );
    logger.info("squash_completed", {
      mergePath,
      branchName: input.branchName,
      targetBranch: input.targetBranch,
      mergeHash,
    });
    return { mergeHash };
  } finally {
    release();
  }
}

export const graphContextSquashMergeActor = fromPromise<
  SquashMergeOutput,
  SquashMergeInput
>(async ({ input }) =>
  runGraphContextSquashMerge({ squashMerge, acquireProjectLock }, input),
);
