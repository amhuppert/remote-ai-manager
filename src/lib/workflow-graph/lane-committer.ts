import { realpath as defaultRealpath } from "node:fs/promises";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  commitChanges as defaultCommitChanges,
  getHeadCommit as defaultGetHeadCommit,
  hasUncommittedChanges as defaultHasUncommittedChanges,
} from "@/lib/git/commits";
import {
  commitOwnedPaths as defaultCommitOwnedPaths,
  type OwnedLandingRequest,
  type OwnedLandingResult,
} from "@/lib/git/owned-landing";
import { createLogger } from "@/lib/logging";
import { landingIntentTrailer } from "@/lib/workflow-graph/route-runtime";
import type {
  GraphWorkflowCanonicalOwnership,
  GraphWorkflowExecution,
  GraphWorkflowExecutionLaneCommitSnapshot,
} from "@/lib/workflow-graph/schemas";
const logger = createLogger("graph-workflow-lane-commit");

/**
 * Append the landing token as a commit trailer (D4 decision D8) so the landing
 * carries its own replayable evidence: reconciliation can probe the branch for
 * the token instead of trusting a runner that may not have survived.
 */
function withLandingTrailer(
  message: string,
  token: string | null | undefined,
): string {
  return token ? `${message}\n\n${landingIntentTrailer(token)}` : message;
}

export interface LaneCommitterInput {
  projectPath: string;
  sessionName: string;
  contextId: string;
  laneId: string;
  laneWorktreePath: string;
  /** Lane HEAD captured before the context's first turn, or null when the
   *  capture failed/never happened. Baseline for adopting agent-made commits
   *  as the context's snapshot when the commit phase finds a clean worktree. */
  preTurnHeadSha: string | null;
  /** The dispatch-time landing token (D4 decision D8), embedded as a commit
   *  trailer so the landing is replayable from the branch alone. Null for a
   *  context dispatched before intents existed. */
  landingToken?: string | null;
  /**
   * The write envelope this context was admitted under, frozen at reservation
   * (lightweight-parallelism decision D7). Required rather than optional: it
   * chooses between two landings that differ in what they may sweep up, and a
   * caller that forgot to thread it would silently get the whole-tree one.
   * Null only for a context that has no frozen envelope at all, which is the
   * pre-placement shape and lands whole-tree exactly as it always did.
   */
  ownership: GraphWorkflowCanonicalOwnership | null;
}

export type LaneCommitterResult =
  | { status: "committed"; snapshot: GraphWorkflowExecutionLaneCommitSnapshot }
  | { status: "adopted"; snapshot: GraphWorkflowExecutionLaneCommitSnapshot }
  | { status: "skipped" }
  | { status: "failed"; errorMessage: string };

export interface LaneCommitter {
  commit(input: LaneCommitterInput): Promise<LaneCommitterResult>;
  /** Best-effort HEAD capture for the adoption baseline: never throws,
   *  returns null when HEAD cannot be resolved. */
  resolveHead(worktreePath: string): Promise<string | null>;
}

export interface LaneCommitterDeps {
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
  commitChanges(
    worktreePath: string,
    message: string,
    options?: { skipHooks?: boolean },
  ): Promise<{ hash: string }>;
  commitOwnedPaths(request: OwnedLandingRequest): Promise<OwnedLandingResult>;
  resolveHeadSha(worktreePath: string): Promise<string | null>;
  realpath(target: string): Promise<string>;
  now(): string;
}

/**
 * Turn the frozen canonical prefixes back into the repo-relative pathspecs the
 * landing primitive commits by.
 *
 * The freeze stores absolute symlink-resolved paths because that is the form
 * admission compares and the sandbox enforces; git wants them relative to the
 * worktree root. Resolving the root the same way is what makes the subtraction
 * valid — CC reaches worktrees through symlinked parents (`/tmp` on macOS is
 * one), so a lexical subtraction against the unresolved root would leave a
 * `../…` escape on every prefix.
 *
 * Throws on a prefix that does not sit under the root: an owning landing that
 * cannot name its own surface must refuse, never widen.
 */
function toOwnedPathspecs(
  canonicalWorktreeRoot: string,
  canonicalPrefixes: readonly string[],
): string[] {
  return canonicalPrefixes.map((prefix) => {
    const relative = path.relative(canonicalWorktreeRoot, prefix);
    if (
      relative.length === 0 ||
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `frozen owned prefix "${prefix}" does not sit under the lane worktree "${canonicalWorktreeRoot}"`,
      );
    }
    return relative.split(path.sep).join("/");
  });
}

export function createLaneCommitter(
  deps: LaneCommitterDeps = {
    hasUncommittedChanges: defaultHasUncommittedChanges,
    commitChanges: defaultCommitChanges,
    commitOwnedPaths: defaultCommitOwnedPaths,
    resolveHeadSha: defaultGetHeadCommit,
    realpath: defaultRealpath,
    now: () => new Date().toISOString(),
  },
): LaneCommitter {
  async function resolveHead(worktreePath: string): Promise<string | null> {
    try {
      return await deps.resolveHeadSha(worktreePath);
    } catch {
      return null;
    }
  }

  /**
   * Land an enveloped context: exactly its owned paths, and never the moved
   * HEAD.
   *
   * Adoption is deliberately absent here. On a shared lane a clean-looking
   * HEAD move is far more likely to be a SIBLING's landing than this context's
   * own self-commit — and an owning context cannot self-commit anyway, since
   * the write envelope denies it `.git`. Adopting would credit one member with
   * another's commit and hand the join a snapshot range spanning both.
   */
  async function commitOwned(
    input: LaneCommitterInput,
    ownership: GraphWorkflowCanonicalOwnership,
  ): Promise<LaneCommitterResult> {
    const { projectPath, sessionName, contextId, laneId, laneWorktreePath } =
      input;

    let ownedPaths: string[];
    try {
      if (ownership.canonicalPrefixes.length === 0) {
        // An owning grade with no surface is a contradiction the schema refuses
        // at authoring, so reaching it means the freeze was lost. Falling back
        // to the whole-tree commit would sweep up every sibling's in-progress
        // work — the one outcome the envelope exists to prevent.
        throw new Error(
          `context "${contextId}" is placed as an owning lane member but carries no frozen owned prefixes`,
        );
      }
      const canonicalRoot = await deps.realpath(laneWorktreePath);
      ownedPaths = toOwnedPathspecs(canonicalRoot, ownership.canonicalPrefixes);
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      logger.error("graph-workflow.lane_commit.owned_envelope_unusable", {
        projectPath,
        sessionName,
        contextId,
        laneId,
        laneWorktreePath,
        error: errorMessage,
      });
      return { status: "failed", errorMessage };
    }

    logger.info("graph-workflow.lane_commit.owned_started", {
      projectPath,
      sessionName,
      contextId,
      laneId,
      laneWorktreePath,
      ownedPathCount: ownedPaths.length,
    });

    try {
      const landing = await deps.commitOwnedPaths({
        worktreePath: laneWorktreePath,
        message: withLandingTrailer(
          `Graph workflow context ${contextId}`,
          input.landingToken,
        ),
        ownedPaths,
      });

      if (landing.status === "no-changes") {
        logger.info("graph-workflow.lane_commit.owned_skipped", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
        });
        return { status: "skipped" };
      }

      const snapshot: GraphWorkflowExecutionLaneCommitSnapshot = {
        contextId,
        sha: landing.hash,
        committedAt: deps.now(),
      };
      logger.info("graph-workflow.lane_commit.owned_completed", {
        projectPath,
        sessionName,
        contextId,
        laneId,
        laneWorktreePath,
        hash: landing.hash,
        committedAt: snapshot.committedAt,
      });
      return { status: "committed", snapshot };
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      logger.error("graph-workflow.lane_commit.owned_failed", {
        projectPath,
        sessionName,
        contextId,
        laneId,
        laneWorktreePath,
        error: errorMessage,
      });
      return { status: "failed", errorMessage };
    }
  }

  return {
    resolveHead,
    async commit(input) {
      const { projectPath, sessionName, contextId, laneId, laneWorktreePath } =
        input;

      const ownership = input.ownership;
      if (ownership !== null && ownership.mode === "owned") {
        return commitOwned(input, ownership);
      }
      if (ownership !== null && ownership.mode === "readOnly") {
        // A read-only member delivers through structured output alone. Its
        // "clean" worktree is full of its siblings' work, so both the
        // whole-tree commit and HEAD adoption would attribute their landings
        // to a context that wrote nothing.
        logger.info("graph-workflow.lane_commit.read_only_skipped", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
        });
        return { status: "skipped" };
      }

      const hasChanges = await deps.hasUncommittedChanges(laneWorktreePath);
      if (!hasChanges) {
        // Implementer agents routinely commit their own work during the turn,
        // leaving the worktree clean here. Adopt the moved HEAD as the
        // context's commit snapshot so the evidence chain (lane-commit event
        // → commit evidence → changedCode) still records the delivered work.
        // Without a pre-turn baseline we skip conservatively rather than
        // attribute fork-point or join-merge commits to this context.
        if (input.preTurnHeadSha !== null) {
          const headSha = await resolveHead(laneWorktreePath);
          if (headSha !== null && headSha !== input.preTurnHeadSha) {
            const snapshot: GraphWorkflowExecutionLaneCommitSnapshot = {
              contextId,
              sha: headSha,
              committedAt: deps.now(),
            };
            logger.info("graph-workflow.lane_commit.adopted_head", {
              projectPath,
              sessionName,
              contextId,
              laneId,
              laneWorktreePath,
              preTurnHeadSha: input.preTurnHeadSha,
              hash: headSha,
              committedAt: snapshot.committedAt,
            });
            return { status: "adopted", snapshot };
          }
        }
        logger.info("graph-workflow.lane_commit.skipped", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
        });
        return { status: "skipped" };
      }

      const message = withLandingTrailer(
        `Graph workflow context ${contextId}`,
        input.landingToken,
      );
      logger.info("graph-workflow.lane_commit.started", {
        projectPath,
        sessionName,
        contextId,
        laneId,
        laneWorktreePath,
      });
      try {
        const { hash } = await deps.commitChanges(laneWorktreePath, message, {
          skipHooks: true,
        });
        const snapshot: GraphWorkflowExecutionLaneCommitSnapshot = {
          contextId,
          sha: hash,
          committedAt: deps.now(),
        };
        logger.info("graph-workflow.lane_commit.completed", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
          hash,
          committedAt: snapshot.committedAt,
        });
        return { status: "committed", snapshot };
      } catch (err) {
        const errorMessage = getErrorMessage(err);
        logger.error("graph-workflow.lane_commit.failed", {
          projectPath,
          sessionName,
          contextId,
          laneId,
          laneWorktreePath,
          error: errorMessage,
        });
        return { status: "failed", errorMessage };
      }
    },
  };
}

/**
 * Append a commit snapshot to the lane's audit history and update its
 * lastCommittingContextId / updatedAt. Pure: returns a new execution object
 * without mutating the input.
 *
 * The snapshot list is an audit/recovery record only. Git remains the
 * authoritative source for the lane's current HEAD — recovery code must
 * read the current branch state from git, not derive it from the snapshot
 * list, since snapshots can lag behind or omit external commits.
 */
export function applyLaneCommitSnapshot(
  execution: GraphWorkflowExecution,
  laneId: string,
  snapshot: GraphWorkflowExecutionLaneCommitSnapshot,
): GraphWorkflowExecution {
  const lane = execution.executionLanes[laneId];
  if (!lane) {
    throw new Error(
      `applyLaneCommitSnapshot: lane ${JSON.stringify(
        laneId,
      )} not found in execution.executionLanes (executionId=${execution.id})`,
    );
  }

  const includedContextIds = lane.includedContextIds.includes(
    snapshot.contextId,
  )
    ? lane.includedContextIds
    : [...lane.includedContextIds, snapshot.contextId];

  return {
    ...execution,
    executionLanes: {
      ...execution.executionLanes,
      [laneId]: {
        ...lane,
        commitSnapshots: [...lane.commitSnapshots, snapshot],
        lastCommittingContextId: snapshot.contextId,
        updatedAt: snapshot.committedAt,
        includedContextIds,
      },
    },
  };
}
