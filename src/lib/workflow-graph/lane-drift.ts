/**
 * Judging post-landing worktree dirt against a lane's collective ownership
 * (lightweight-parallelism decision D8).
 *
 * The write envelope is the primary defence, but it is enforced by the backend
 * sandbox, and a sandbox only sees writes the agent's own process makes. A
 * server-mediated write — CC's own tooling, an MCP server, a dev server —
 * reaches the shared worktree by a route no sandbox can intercept. This is the
 * check that catches those, and it runs at the one moment the answer is
 * unambiguous: right after a member landed, when everything still dirty is
 * either a sibling's declared work or nobody's.
 *
 * Judgement is against the LANE UNION rather than the landing member's own
 * ownership, because git cannot attribute a shared worktree's changes to an
 * agent. Sibling-owned dirt is expected during a landing and must never halt;
 * the halt is for paths that no current member declared at all, and it names
 * the lane rather than pretending to know which member wrote them.
 *
 * What it judges is what git tracks: the tracked and untracked entries `git
 * status` reports. That is the boundary where the finding is worth a halt —
 * an unattributed change git tracks gets swept into someone else's commit or
 * lost at the next landing, so merge integrity depends on it.
 *
 * Ignored content is not judged at all. The writes that appear there are the
 * toolchain doing its job — an install regenerating a package tree, an
 * incremental typecheck rewriting its build info — and they are
 * observationally identical to the foreign write a check there would be hunting
 * for. No threshold separates them, so the check would only convert correct
 * runs into halts.
 *
 * The engine's own `.cc` artifacts never reach this judgment: `.cc/` is
 * excluded in the shared common dir before the first artifact lands there, and
 * a failure to establish that exclusion fails materialization outright. The
 * one shape that can surface a `.cc` entry is a repo that has COMMITTED one —
 * an exclude rule does not untrack — and that abnormal tree state is judged
 * like any other path: unattributed unless a member owns it.
 */

import { realpath as defaultRealpath } from "node:fs/promises";
import path from "node:path";
import {
  readWorktreeStatusV2 as defaultReadWorktreeStatusV2,
  type WorktreeStatusEntry,
} from "@/lib/git/worktree";
import type { GraphWorkflowCanonicalOwnership } from "@/lib/workflow-graph/schemas";

export interface ClassifyLaneDriftInput {
  /** Non-ignored dirty entries, as porcelain v2 reports them. */
  readonly entries: readonly WorktreeStatusEntry[];
  /** Repo-relative owned prefixes, unioned across every current member. */
  readonly ownedPrefixes: readonly string[];
  /** Whether any current member holds unrestricted access to the lane. */
  readonly hasFullAccessMember: boolean;
}

export interface LaneDriftVerdict {
  /** Sorted and de-duplicated; empty means the landing is clean. */
  readonly unattributedPaths: readonly string[];
}

/**
 * Prefix containment at segment boundaries, so `src/api` covers
 * `src/api/handler.ts` but not the unrelated sibling `src/apix`.
 */
function covers(prefix: string, candidate: string): boolean {
  return candidate === prefix || candidate.startsWith(`${prefix}/`);
}

function coveredByAny(prefixes: readonly string[], candidate: string): boolean {
  return prefixes.some((prefix) => covers(prefix, candidate));
}

export function classifyLaneDrift(
  input: ClassifyLaneDriftInput,
): LaneDriftVerdict {
  // A full-access member declares no surface precisely because it holds the
  // whole tree, so there is no path in the worktree it could fail to account
  // for. Placement validation already forbids it from running concurrently
  // with another write-capable member, so nothing else is in flight to blame.
  if (input.hasFullAccessMember) return { unattributedPaths: [] };

  const unattributed = new Set<string>();

  for (const entry of input.entries) {
    // Both endpoints: a rename is a write at the destination AND a deletion at
    // the source, and either one can fall outside the union on its own.
    const endpoints =
      entry.originalPath === null
        ? [entry.path]
        : [entry.path, entry.originalPath];

    for (const endpoint of endpoints) {
      if (coveredByAny(input.ownedPrefixes, endpoint)) continue;
      unattributed.add(endpoint);
    }
  }

  return { unattributedPaths: [...unattributed].sort() };
}

export interface LaneOwnershipUnion {
  readonly ownedPrefixes: readonly string[];
  readonly hasFullAccessMember: boolean;
}

/**
 * Collapse the current members' frozen envelopes into the repo-relative union
 * the classifier judges against.
 *
 * A prefix that no longer resolves under the lane worktree is dropped rather
 * than emitted: it cannot describe anything git will report, and carrying it
 * would only widen the union with a path that matches nothing. The narrowing is
 * safe in the direction that matters — a dropped prefix can only cause a halt,
 * never suppress one.
 */
export function laneOwnedPrefixes(
  canonicalWorktreeRoot: string,
  memberOwnerships: readonly GraphWorkflowCanonicalOwnership[],
): LaneOwnershipUnion {
  const ownedPrefixes: string[] = [];
  let hasFullAccessMember = false;

  for (const ownership of memberOwnerships) {
    if (ownership.mode === "full") {
      hasFullAccessMember = true;
      continue;
    }
    for (const prefix of ownership.canonicalPrefixes) {
      const relative = path.relative(canonicalWorktreeRoot, prefix);
      if (
        relative.length === 0 ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
      ) {
        continue;
      }
      const posix = relative.split(path.sep).join("/");
      if (!ownedPrefixes.includes(posix)) ownedPrefixes.push(posix);
    }
  }

  return { ownedPrefixes, hasFullAccessMember };
}

/**
 * The engine-facing seam: read the lane worktree and judge it in one call, so
 * the landing call site never has to know that renames carry two endpoints.
 */
export interface LaneDriftAuditor {
  audit(input: LaneDriftAuditInput): Promise<LaneDriftVerdict>;
}

export interface LaneDriftAuditInput {
  readonly laneWorktreePath: string;
  /** Every current member's frozen envelope, in any order. */
  readonly memberOwnerships: readonly GraphWorkflowCanonicalOwnership[];
}

export interface LaneDriftAuditorDeps {
  readStatus(worktreePath: string): Promise<WorktreeStatusEntry[]>;
  realpath(target: string): Promise<string>;
}

/**
 * The filesystem reads live here rather than at the landing call site: the
 * frozen prefixes are absolute and symlink-resolved while git reports
 * repo-relative paths, so canonicalizing the worktree root is part of asking
 * the question, not part of deciding to ask it.
 */
export function createLaneDriftAuditor(
  deps: LaneDriftAuditorDeps = {
    readStatus: (worktreePath) => defaultReadWorktreeStatusV2(worktreePath),
    realpath: defaultRealpath,
  },
): LaneDriftAuditor {
  return {
    async audit(input) {
      const canonicalRoot = await deps.realpath(input.laneWorktreePath);
      const union = laneOwnedPrefixes(canonicalRoot, input.memberOwnerships);
      const entries = await deps.readStatus(input.laneWorktreePath);
      return classifyLaneDrift({
        entries,
        ownedPrefixes: union.ownedPrefixes,
        hasFullAccessMember: union.hasFullAccessMember,
      });
    },
  };
}
