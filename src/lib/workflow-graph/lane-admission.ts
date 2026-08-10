/**
 * Whether two contexts may hold one lane worktree at the same time.
 *
 * Definition validation already refuses same-lane concurrency that is unsafe on
 * the DECLARED strings (`placement-validation.ts`). This module owns the half
 * that only the runtime can decide: two prefixes that look distinct as authored
 * can resolve into one another on disk, and a lane's occupancy changes pass by
 * pass. It is split into the two halves the admission protocol needs
 * (decision D4):
 *
 *  - {@link canonicalizeOwnership} does the symlink-resolution I/O. It runs as
 *    an explicit stage OUTSIDE the repository write queue, because the
 *    reservation reducer runs on the sync write-queue entry and cannot perform
 *    I/O.
 *  - {@link classifyLaneAdmission} is pure and compares FROZEN canonical sets.
 *    It is what the reducer calls, so the admission decision is atomic against
 *    co-candidates in the same batch and against a concurrent scheduler.
 *
 * The canonical set a candidate is admitted under is the same set its turn is
 * enforced under — freezing it here is what makes "the envelope the scheduler
 * reserved" and "the envelope the backend enforces" the same bytes, so a
 * symlink retargeted between the two stages cannot widen either one.
 */

import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ContextPlacement } from "@/lib/workflow-graph/definition-schemas";
import type { GraphWorkflowCanonicalOwnership } from "@/lib/workflow-graph/schemas";

/**
 * A placement's write surface, resolved to absolute canonical paths — the
 * persisted shape, so what admission compares and what the execution stores are
 * the same value rather than two types that have to be kept in step.
 */
export type CanonicalOwnership = GraphWorkflowCanonicalOwnership;

/** A context already holding (or already reserved on) the lane. */
export interface LaneOccupant {
  contextId: string;
  ownership: CanonicalOwnership;
}

export type LaneAdmissionVerdict =
  | { kind: "admit" }
  | {
      kind: "refuse";
      reason: "full-access-exclusive" | "ownership-collision";
      blockingContextId: string;
      /** The candidate's prefix and the occupant's, for a collision only. */
      collidingPrefixes: readonly [string, string] | null;
    };

export interface CanonicalizeOwnershipInput {
  placement: ContextPlacement;
  /** Absolute path of the lane worktree the context will run in. */
  laneWorktreePath: string;
}

export interface CanonicalizeOwnershipDeps {
  realpath?(target: string): string;
  /** The link target of `target`, or null when it is not a symlink. */
  readLink?(target: string): string | null;
}

/**
 * Compare canonical paths case-insensitively.
 *
 * Canonicalization resolves the EXISTING portion of a prefix to its true
 * on-disk spelling, so two spellings of a directory that exists already agree.
 * A not-yet-created suffix has no on-disk casing to resolve, and CC runs where
 * a case-insensitive filesystem makes `src/Api` and `src/api` one directory.
 * Folding the case can only ever refuse a pair that a case-sensitive filesystem
 * would have kept apart, and a refusal serializes the two contexts rather than
 * failing either one — the direction fail-closed requires.
 */
function coversPath(outer: string, inner: string): boolean {
  const outerKey = outer.toLowerCase();
  const innerKey = inner.toLowerCase();
  return outerKey === innerKey || innerKey.startsWith(`${outerKey}${path.sep}`);
}

function prefixesOverlap(left: string, right: string): boolean {
  return coversPath(left, right) || coversPath(right, left);
}

function isWriteCapable(ownership: CanonicalOwnership): boolean {
  return ownership.mode !== "readOnly";
}

/**
 * May `candidate` join the lane its `occupants` already hold?
 *
 * Read-only members write nothing in the worktree, so they neither collide nor
 * are collided with. A full-access member declares no surface to be disjoint
 * FROM, so it takes the lane exclusively. Two owning members are admissible
 * exactly when no prefix of either covers a prefix of the other.
 *
 * A refusal is a WAIT, not an error: the candidate stays eligible and is
 * admitted on a later pass once the occupant settles.
 */
export function classifyLaneAdmission(input: {
  candidate: CanonicalOwnership;
  occupants: readonly LaneOccupant[];
}): LaneAdmissionVerdict {
  const { candidate, occupants } = input;
  if (!isWriteCapable(candidate)) return { kind: "admit" };

  for (const occupant of occupants) {
    if (!isWriteCapable(occupant.ownership)) continue;
    if (candidate.mode === "full" || occupant.ownership.mode === "full") {
      return {
        kind: "refuse",
        reason: "full-access-exclusive",
        blockingContextId: occupant.contextId,
        collidingPrefixes: null,
      };
    }
    for (const candidatePrefix of candidate.canonicalPrefixes) {
      for (const occupantPrefix of occupant.ownership.canonicalPrefixes) {
        if (!prefixesOverlap(candidatePrefix, occupantPrefix)) continue;
        return {
          kind: "refuse",
          reason: "ownership-collision",
          blockingContextId: occupant.contextId,
          collidingPrefixes: [candidatePrefix, occupantPrefix],
        };
      }
    }
  }

  return { kind: "admit" };
}

/**
 * Total link expansions allowed while canonicalizing one path — the same budget
 * the kernel spends before `ELOOP`. Counted across the whole walk rather than
 * per component, so a cycle reached through a chain of links still terminates.
 */
const MAX_SYMLINK_HOPS = 40;

/**
 * Whether a failed probe PROVED the component absent — the only failure that
 * may be read as "not a symlink".
 *
 * `ENOENT` is plain absence, and `ENOTDIR` is absence too: a component of the
 * prefix is a regular file, so nothing can ever exist below it. Every other
 * failure (`EACCES` on an unreadable ancestor, `EIO`, `ELOOP`,
 * `ENAMETOOLONG`, …) leaves the question unanswered. Answering "not a symlink"
 * there is the lexical fallback the enforcement precedent forbids: the prefix
 * freezes as authored and can be admitted beside an owner it aliases the moment
 * the condition clears.
 */
function isAbsenceError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const { code } = error;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * The link target of `target`, null when it is proven not to be a symlink, and
 * a throw when the probe could not decide.
 */
function defaultReadLink(target: string): string | null {
  let stats;
  try {
    stats = lstatSync(target);
  } catch (error) {
    if (isAbsenceError(error)) return null;
    throw new Error(
      `Cannot determine whether "${target}" is a symlink: ${getErrorMessage(error)}`,
    );
  }
  if (!stats.isSymbolicLink()) return null;
  // A `readlink` failure after `lstat` said "symlink" is a race, not an
  // absence: fail closed rather than fall back to the authored spelling.
  return readlinkSync(target);
}

/**
 * The canonical path `target` denotes, resolving every symlink component —
 * including one whose own target does not exist yet.
 *
 * `realpath` cannot be the primitive here, and neither can the
 * `mkdir`-before-`realpath` shape `lane-write-policy` uses. A checked-out tree
 * routinely holds a DANGLING link, because Git does not track empty
 * directories: `src/mirror -> generated` survives a checkout with
 * `src/generated` absent. `realpath` fails on that link and so does `mkdir -p`
 * (both ENOENT), so either one would leave the authored spelling standing —
 * freezing `src/mirror` and `src/generated` as distinct prefixes that become
 * ONE directory the moment either owner creates it. Materializing prefixes is
 * doubly wrong here anyway: an owned prefix may name a FILE, which `mkdir`
 * would create as a directory, and a scheduler that writes into the repository
 * to decide who may write into the repository has already lost the argument.
 *
 * So the path is walked one component at a time over a queue of segments still
 * to resolve, and `current` holds the canonical prefix resolved so far. A
 * component that is a link does not resolve to its target: its target is itself
 * a path whose own components can be links, so the target's segments are pushed
 * back onto the FRONT of the queue and walked from `current` (or from the root,
 * for an absolute target). Substituting the link target wholesale instead —
 * `resolve(dirname, link)` — leaves those ancestors unresolved, so
 * `mirror -> alias/handlers` over `alias -> api` would freeze as
 * `.../src/alias/handlers` and read as disjoint from `.../src/api/handlers`,
 * which is the same directory.
 *
 * A component PROVEN absent is not a link, so the walk continues through it and
 * the remainder resolves lexically — safe, because a path that exists nowhere
 * aliases nothing, and any link later created there is seen by the next freeze.
 * A probe that cannot answer is not proof of absence and throws instead
 * ({@link isAbsenceError}). `..` pops `current`, which is sound precisely because
 * `current` is already canonical. A chain that will not terminate fails closed
 * rather than resolving to a guess.
 */
function canonicalizePath(
  target: string,
  readLink: (candidate: string) => string | null,
): string {
  const segmentsOf = (value: string, root: string): string[] =>
    value
      .slice(root.length)
      .split(path.sep)
      .filter((segment) => segment.length > 0);

  const resolved = path.resolve(target);
  const { root } = path.parse(resolved);
  const pending = segmentsOf(resolved, root);

  let current = root;
  let hops = 0;
  while (pending.length > 0) {
    const segment = pending.shift();
    if (segment === undefined || segment === ".") continue;
    if (segment === "..") {
      current = path.dirname(current);
      continue;
    }

    const candidate = path.join(current, segment);
    const link = readLink(candidate);
    if (link === null) {
      current = candidate;
      continue;
    }

    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) {
      throw new Error(
        `Symlink chain at "${candidate}" exceeded ${MAX_SYMLINK_HOPS} hops while canonicalizing "${target}"`,
      );
    }
    if (path.isAbsolute(link)) {
      const linkRoot = path.parse(link).root;
      pending.unshift(...segmentsOf(link, linkRoot));
      current = linkRoot;
    } else {
      pending.unshift(...segmentsOf(link, ""));
    }
  }
  return current;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative.length > 0 &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

/**
 * Whether `laneWorktreePath` exists, and so whether a freeze taken against it
 * resolved real directory entries or merely appended the authored spelling to
 * the longest existing ancestor.
 *
 * A lane the pass is about to MINT has no worktree yet, so every prefix under
 * it canonicalizes lexically — there is nothing on disk to resolve. That answer
 * is PROVISIONAL, not wrong-but-safe: `git worktree add` then checks the source
 * branch out, and a symlink committed on that branch can alias two prefixes
 * that were frozen as disjoint. Callers mark such a freeze and re-canonicalize
 * it once the worktree exists, before anyone is allowed to start.
 */
export function laneWorktreeExists(
  laneWorktreePath: string,
  deps: CanonicalizeOwnershipDeps = {},
): boolean {
  const realpath = deps.realpath ?? realpathSync;
  try {
    realpath(laneWorktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Freeze a placement's write surface into canonical absolute paths under its
 * lane worktree. Performs filesystem reads; never mutates anything.
 *
 * Fail-closed: a prefix that resolves outside the lane worktree throws rather
 * than being silently dropped or lexically approximated. The authored form
 * cannot express an escape (the schema refuses absolute paths and `..`), so an
 * escape here means a symlink leads out of the worktree — exactly the case an
 * ownership envelope exists to make impossible.
 */
export function canonicalizeOwnership(
  input: CanonicalizeOwnershipInput,
  deps: CanonicalizeOwnershipDeps = {},
): CanonicalOwnership {
  const readLink = deps.readLink ?? defaultReadLink;
  const { placement } = input;
  if (placement.mode !== "owned") {
    return { mode: placement.mode, canonicalPrefixes: [] };
  }

  let root: string;
  try {
    root = canonicalizePath(input.laneWorktreePath, readLink);
  } catch (error) {
    throw new Error(
      `Cannot canonicalize lane worktree "${input.laneWorktreePath}": ${getErrorMessage(error)}`,
    );
  }

  const canonicalPrefixes: string[] = [];
  for (const ownedPath of placement.ownedPaths) {
    let resolved: string;
    try {
      resolved = canonicalizePath(path.join(root, ownedPath), readLink);
    } catch (error) {
      throw new Error(
        `Cannot canonicalize owned path "${ownedPath}": ${getErrorMessage(error)}`,
      );
    }
    if (!isInside(root, resolved)) {
      throw new Error(
        `Owned path "${ownedPath}" resolves to "${resolved}", which escapes the lane worktree "${root}"`,
      );
    }
    if (!canonicalPrefixes.includes(resolved)) canonicalPrefixes.push(resolved);
  }

  return { mode: "owned", canonicalPrefixes };
}
