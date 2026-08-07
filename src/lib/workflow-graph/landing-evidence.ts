/**
 * Reading landing evidence back off the branch (D4 decision D8).
 *
 * A landing intent is a promise made at dispatch; this is how the promise is
 * checked after a crash. `lane_commit` and `solo_commit` land through a commit,
 * so the branch itself carries the evidence: the deterministic
 * `Landing-Intent:` trailer the committers embed, or — for a commit the
 * implementer authored itself, which carries no trailer — the recorded
 * baseline → head range.
 *
 * The facts are read HERE and classified in `route-runtime.ts`. Splitting them
 * is what lets reconciliation stay pure and run inside the write queue while
 * the git I/O happens outside it.
 */

import { access } from "node:fs/promises";

import { defaultGitClient, type GitClient } from "@/lib/git/client";
import { createLogger } from "@/lib/logging";
import {
  landingIntentTrailer,
  type LandingBranchEvidence,
  type LandingProbeTarget,
} from "@/lib/workflow-graph/route-runtime";

const logger = createLogger("graph-workflow-landing-evidence");

export interface LandingEvidenceProber {
  probe(
    targets: readonly LandingProbeTarget[],
  ): Promise<Map<string, LandingBranchEvidence>>;
}

export interface LandingEvidenceProberDeps {
  git(args: string[], cwd: string): Promise<{ stdout: string }>;
  pathExists(path: string): Promise<boolean>;
}

function defaultDeps(
  client: GitClient = defaultGitClient,
): LandingEvidenceProberDeps {
  return {
    git: (args, cwd) => client.git(args, cwd),
    pathExists: async (path) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createLandingEvidenceProber(
  deps: LandingEvidenceProberDeps = defaultDeps(),
): LandingEvidenceProber {
  async function read(args: string[], cwd: string): Promise<string | null> {
    try {
      const { stdout } = await deps.git(args, cwd);
      return stdout.trim();
    } catch {
      // A worktree that was removed, a branch that was rewritten, a repo that
      // no longer resolves: none of them are evidence of a landing, and none
      // of them may abort the restart that asked.
      return null;
    }
  }

  async function probeOne(
    target: LandingProbeTarget,
  ): Promise<LandingBranchEvidence> {
    const { worktreePath, baselineSha } = target;

    const head = await read(["rev-parse", "HEAD"], worktreePath);
    const tokenCommit = await read(
      [
        "log",
        "--max-count=1",
        "--fixed-strings",
        `--grep=${landingIntentTrailer(target.token)}`,
        "--format=%H",
        "HEAD",
      ],
      worktreePath,
    );
    const baselineReachable =
      baselineSha === null
        ? false
        : (await read(
            ["merge-base", "--is-ancestor", baselineSha, "HEAD"],
            worktreePath,
          )) !== null;

    return {
      headSha: head === null || head.length === 0 ? null : head,
      tokenCommitSha:
        tokenCommit === null || tokenCommit.length === 0
          ? null
          : (tokenCommit.split("\n")[0] ?? null),
      baselineReachable,
    };
  }

  return {
    async probe(targets) {
      const evidence = new Map<string, LandingBranchEvidence>();
      for (const target of targets) {
        if (!(await deps.pathExists(target.worktreePath))) continue;
        const probed = await probeOne(target);
        evidence.set(target.contextId, probed);
        logger.debug("graph-workflow.landing.probed", {
          contextId: target.contextId,
          worktreePath: target.worktreePath,
          hasTokenCommit: probed.tokenCommitSha !== null,
          baselineReachable: probed.baselineReachable,
        });
      }
      return evidence;
    },
  };
}
