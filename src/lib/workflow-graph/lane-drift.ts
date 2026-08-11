/**
 * Judging post-landing worktree dirt against a lane's collective ownership
 * (lightweight-parallelism decision D8).
 *
 * The write envelope is the primary defence, but it is enforced by the backend
 * sandbox, and a sandbox only sees writes the agent's own process makes. A
 * server-mediated write — CC's own tooling, an MCP server, a dev server, a
 * post-install hook — reaches the shared worktree by a route no sandbox can
 * intercept. This is the check that catches those, and it runs at the one
 * moment the answer is unambiguous: right after a member landed, when
 * everything still dirty is either a sibling's declared work or nobody's.
 *
 * Judgement is against the LANE UNION rather than the landing member's own
 * ownership, because git cannot attribute a shared worktree's changes to an
 * agent. Sibling-owned dirt is expected during a landing and must never halt;
 * the halt is for paths that no current member declared at all, and it names
 * the lane rather than pretending to know which member wrote them.
 *
 * Ignored paths get no blanket exemption. `.gitignore` says "this is not
 * repository content", not "nobody wrote this" — and the writes worth catching
 * (a leaked credential file, a tool dumping state into the worktree) tend to be
 * exactly the ones a project already ignores. So ignored paths are judged
 * against a baseline captured when the lane was provisioned: what was there
 * before the members started is theirs to keep, and anything new is drift.
 *
 * Two grains are in play there, and mixing them up is how this check would fail
 * open. Git names ignored content the way the ignore rules do, so `node_modules`
 * is one entry whether it holds ten files or ten thousand — a baseline compared
 * at that grain would accept a credential dropped inside it as pre-existing
 * state. Ignored paths therefore arrive here per FILE, and a baseline entry
 * carries a digest of what its directory held rather than only its name. The
 * cost of that precision is the report: a file no baseline covers is named
 * exactly, while a change inside a baselined directory names the directory.
 *
 * The digest covers each file's byte and filesystem identity, not just its
 * path, because the three ways ignored content changes are all invisible to a
 * set of names: a file APPEARS, a file DISAPPEARS, and a file is OVERWRITTEN in
 * place. The last is the one a credential drop actually looks like when the
 * install already put a file at that path, and it adds no name at all.
 *
 * A directory digest asks "did anything under here change?", which is the wrong
 * question where part of that directory is a CURRENT member's write surface —
 * an owner's legitimate edit under a broad ignore rule would read as drift.
 * Provisioning therefore keeps a per-file manifest in the lane's private git
 * metadata while the execution state carries only bounded root digests. Each
 * audit filters BOTH the manifest and the current entries by the current lane
 * union before comparing them. A future, skipped, removed, or replaced member
 * cannot pre-authorize a path merely by appearing in the authored definition.
 */

import { createHash } from "node:crypto";
import { realpath as defaultRealpath } from "node:fs/promises";
import path from "node:path";
import {
  readIgnoredEntries as defaultReadIgnoredEntries,
  readWorktreeStatusV2 as defaultReadWorktreeStatusV2,
  type IgnoredEntry,
  type IgnoredWorktreeContents,
  type WorktreeStatusEntry,
} from "@/lib/git/worktree";
import { createLaneIgnoredBaselineStore } from "./lane-ignored-baseline-store";
import { toLanePathSegment } from "./lane-path-segments";
import type {
  GraphWorkflowCanonicalOwnership,
  GraphWorkflowIgnoredBaselineEntry,
} from "@/lib/workflow-graph/schemas";
import { listManagedSkillsOwnedCheckoutPaths as defaultListManagedSkillsOwnedCheckoutPaths } from "@/lib/agent-backends/registry";

/**
 * Exact worktree surfaces CC itself materializes, which no lane member owns.
 *
 * Enumerated rather than exempting `.cc` wholesale, because "CC's namespace" is
 * not the same claim as "any path beginning with `.cc`": a server-mediated
 * write to `.cc/anything-else` is exactly the unattributable write this check
 * exists to catch, and a blanket exemption would swallow it. Each entry below
 * is a surface the engine itself materializes into a lane worktree during a
 * run — the charter and shared documents, and validation/script logs.
 */
export const ENGINE_RESERVED_PREFIXES: readonly string[] = [
  ".cc/graph-workflow-docs",
  ".cc/workflow",
];

/** CC's artifact namespace, matching `CC_ARTIFACTS_IGNORE_PATTERN`. */
const CC_ARTIFACT_NAMESPACE = ".cc";

/** Where the write envelope injects each member's payload directory. */
const PAYLOAD_NAMESPACE_PREFIX = `${CC_ARTIFACT_NAMESPACE}/temp`;

/**
 * The reserved surface for one lane: the engine's own namespaces plus the
 * payload directory injected for each of the lane's members.
 *
 * Payload directories are per context rather than a blanket `.cc/temp`, so a
 * write into that namespace under a name no member owns still reads as drift.
 */
export function laneReservedPrefixes(
  memberContextIds: readonly string[],
): string[] {
  const reserved = [...ENGINE_RESERVED_PREFIXES];
  for (const contextId of memberContextIds) {
    const prefix = `${PAYLOAD_NAMESPACE_PREFIX}/${toLanePathSegment(contextId)}`;
    if (!reserved.includes(prefix)) reserved.push(prefix);
  }
  return reserved;
}

export interface ClassifyLaneDriftInput {
  /** Non-ignored dirty entries, as porcelain v2 reports them. */
  readonly entries: readonly WorktreeStatusEntry[];
  /** Ignored paths, one entry per FILE — never a collapsed directory. */
  readonly ignoredEntries: readonly IgnoredEntry[];
  /** Repo-relative owned prefixes, unioned across every current member. */
  readonly ownedPrefixes: readonly string[];
  /** The engine and per-member namespaces; see {@link laneReservedPrefixes}. */
  readonly reservedPrefixes: readonly string[];
  /** The ignored content recorded when the lane worktree was provisioned. */
  readonly ignoredBaseline: readonly GraphWorkflowIgnoredBaselineEntry[];
  /** Per-file provisioning manifest, or null when it cannot be recovered. */
  readonly ignoredBaselineEntries: readonly IgnoredEntry[] | null;
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

/** The most specific baselined path covering `candidate`, or null. */
function coveringBaseline(
  baseline: readonly GraphWorkflowIgnoredBaselineEntry[],
  candidate: string,
): GraphWorkflowIgnoredBaselineEntry | null {
  let best: GraphWorkflowIgnoredBaselineEntry | null = null;
  for (const entry of baseline) {
    if (!covers(entry.path, candidate)) continue;
    if (best === null || entry.path.length > best.path.length) best = entry;
  }
  return best;
}

/**
 * The digest a baseline entry stores and the audit recomputes. Both sides must
 * derive it the same way for a comparison to mean anything, so it lives here
 * rather than at either call site.
 *
 * Over each file's identity, not merely its name: an overwrite in place — a
 * credential written on top of a file the install already put there — adds no
 * new path, so a digest of names alone reads it as untouched.
 */
export function digestIgnoredEntries(entries: readonly IgnoredEntry[]): string {
  const lines = entries
    .map((entry) => `${entry.path}\0${entry.fingerprint}`)
    .sort();
  return createHash("sha256").update(lines.join("\0")).digest("hex");
}

export function classifyLaneDrift(
  input: ClassifyLaneDriftInput,
): LaneDriftVerdict {
  // A full-access member declares no surface precisely because it holds the
  // whole tree, so there is no path in the worktree it could fail to account
  // for. Placement validation already forbids it from running concurrently
  // with another write-capable member, so nothing else is in flight to blame.
  if (input.hasFullAccessMember) return { unattributedPaths: [] };

  const attributed = [...input.reservedPrefixes, ...input.ownedPrefixes];
  const unattributed = new Set<string>();

  for (const entry of input.entries) {
    // Both endpoints: a rename is a write at the destination AND a deletion at
    // the source, and either one can fall outside the union on its own.
    const endpoints =
      entry.originalPath === null
        ? [entry.path]
        : [entry.path, entry.originalPath];

    for (const endpoint of endpoints) {
      if (coveredByAny(attributed, endpoint)) continue;
      unattributed.add(endpoint);
    }
  }

  // Every root starts with an empty group on BOTH sides, so deleting the last
  // ignored file remains a comparison rather than disappearing from the audit.
  const currentGrouped = new Map<
    GraphWorkflowIgnoredBaselineEntry,
    IgnoredEntry[]
  >(input.ignoredBaseline.map((entry) => [entry, []]));
  const baselineGrouped = new Map<
    GraphWorkflowIgnoredBaselineEntry,
    IgnoredEntry[]
  >(input.ignoredBaseline.map((entry) => [entry, []]));

  for (const entry of input.ignoredEntries) {
    const baselined = coveringBaseline(input.ignoredBaseline, entry.path);
    if (baselined !== null) {
      if (coveredByAny(attributed, entry.path)) continue;
      currentGrouped.get(baselined)?.push(entry);
      continue;
    }
    // Ignored, and predating nothing: judged exactly like any other write.
    if (coveredByAny(attributed, entry.path)) continue;
    unattributed.add(entry.path);
  }

  if (input.ignoredBaselineEntries === null) {
    // The bounded state proves these roots existed, but without the protected
    // manifest their provisioned file set cannot be reconstructed. Reporting
    // each root is the fail-closed answer; suppress only a root a current member
    // owns in full.
    for (const baselined of input.ignoredBaseline) {
      if (coveredByAny(attributed, baselined.path)) continue;
      unattributed.add(baselined.path);
    }
    return { unattributedPaths: [...unattributed].sort() };
  }

  for (const entry of input.ignoredBaselineEntries) {
    const baselined = coveringBaseline(input.ignoredBaseline, entry.path);
    if (baselined === null || coveredByAny(attributed, entry.path)) continue;
    baselineGrouped.get(baselined)?.push(entry);
  }

  for (const [baselined, currentEntries] of currentGrouped) {
    // A current member owning the whole baselined root accounts for every
    // possible change below it. Narrow ownership was already filtered entry by
    // entry on both sides, leaving siblings under the root fully audited.
    if (coveredByAny(attributed, baselined.path)) continue;
    const baselineEntries = baselineGrouped.get(baselined) ?? [];
    if (
      digestIgnoredEntries(currentEntries) ===
      digestIgnoredEntries(baselineEntries)
    ) {
      continue;
    }
    unattributed.add(baselined.path);
  }

  return { unattributedPaths: [...unattributed].sort() };
}

/**
 * Summarize a worktree's ignored content into the baseline the classifier
 * judges against.
 *
 * CC's own namespace is deliberately left out. A lane worktree has no `.cc`
 * when it is created — the engine materializes one during the run — so
 * baselining it would only matter on a re-provision, and then it would do harm:
 * `.cc` would become a digest-compared directory whose every legitimate engine
 * write reads as drift, and a write hiding inside it would be reported as `.cc`
 * rather than by name. Paths there are judged against the reserved prefixes
 * instead, which is the more precise answer in both directions.
 */
export function summarizeIgnoredContents(
  contents: IgnoredWorktreeContents,
): GraphWorkflowIgnoredBaselineEntry[] {
  const roots = contents.roots.filter(
    (root) => !covers(CC_ARTIFACT_NAMESPACE, root),
  );
  // Each file counts toward its MOST SPECIFIC root only, matching how the audit
  // assigns it later. Nested roots would otherwise be digested over overlapping
  // file sets on one side and disjoint ones on the other, and every comparison
  // between them would fail on shape rather than on content.
  const grouped = new Map<string, IgnoredEntry[]>(
    roots.map((root) => [root, []]),
  );
  for (const entry of contents.entries) {
    if (covers(CC_ARTIFACT_NAMESPACE, entry.path)) continue;
    let owner: string | null = null;
    for (const root of roots) {
      if (!covers(root, entry.path)) continue;
      if (owner === null || root.length > owner.length) owner = root;
    }
    if (owner === null) continue;
    grouped.get(owner)?.push(entry);
  }

  return roots.map((root) => ({
    path: root,
    digest: digestIgnoredEntries(grouped.get(root) ?? []),
  }));
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
 * the landing call site never has to know that ignored paths need their own
 * enumeration or that renames carry two endpoints.
 */
export interface LaneDriftAuditor {
  audit(input: LaneDriftAuditInput): Promise<LaneDriftVerdict>;
}

export interface LaneDriftAuditInput {
  readonly laneWorktreePath: string;
  /** Every current member's frozen envelope, in any order. */
  readonly memberOwnerships: readonly GraphWorkflowCanonicalOwnership[];
  /** Every member the lane has admitted, for their payload directories. */
  readonly memberContextIds: readonly string[];
  readonly ignoredBaseline: readonly GraphWorkflowIgnoredBaselineEntry[];
  /** Test/replay seam; production reads the protected lane manifest. */
  readonly ignoredBaselineEntries?: readonly IgnoredEntry[] | null;
}

export interface LaneDriftAuditorDeps {
  readStatus(worktreePath: string): Promise<WorktreeStatusEntry[]>;
  readIgnoredEntries(worktreePath: string): Promise<IgnoredEntry[]>;
  realpath(target: string): Promise<string>;
  listManagedSkillsOwnedCheckoutPaths?(
    checkoutPath: string,
  ): Promise<readonly string[]>;
  readIgnoredBaselineEntries?(
    worktreePath: string,
  ): Promise<IgnoredWorktreeContents | null>;
}

/**
 * Both filesystem reads live here rather than at the landing call site: the
 * frozen prefixes are absolute and symlink-resolved while git reports
 * repo-relative paths, so canonicalizing the worktree root is part of asking
 * the question, not part of deciding to ask it.
 */
export function createLaneDriftAuditor(
  deps: LaneDriftAuditorDeps = {
    readStatus: (worktreePath) => defaultReadWorktreeStatusV2(worktreePath),
    readIgnoredEntries: (worktreePath) =>
      defaultReadIgnoredEntries(worktreePath),
    realpath: defaultRealpath,
  },
): LaneDriftAuditor {
  const baselineStore = createLaneIgnoredBaselineStore();
  const readIgnoredBaselineEntries =
    deps.readIgnoredBaselineEntries ??
    ((worktreePath: string) => baselineStore.read(worktreePath));
  const listManagedSkillsOwnedCheckoutPaths =
    deps.listManagedSkillsOwnedCheckoutPaths ??
    defaultListManagedSkillsOwnedCheckoutPaths;

  return {
    async audit(input) {
      const canonicalRoot = await deps.realpath(input.laneWorktreePath);
      const union = laneOwnedPrefixes(canonicalRoot, input.memberOwnerships);
      const [entries, ignoredEntries, storedBaseline, managedSkillsOwnedPaths] =
        await Promise.all([
          deps.readStatus(input.laneWorktreePath),
          deps.readIgnoredEntries(input.laneWorktreePath),
          input.ignoredBaselineEntries === undefined
            ? input.ignoredBaseline.length === 0
              ? Promise.resolve({ roots: [], entries: [] })
              : readIgnoredBaselineEntries(input.laneWorktreePath)
            : Promise.resolve(
                input.ignoredBaselineEntries === null
                  ? null
                  : {
                      roots: input.ignoredBaseline.map((entry) => entry.path),
                      entries: input.ignoredBaselineEntries,
                    },
              ),
          listManagedSkillsOwnedCheckoutPaths(input.laneWorktreePath),
        ]);
      const recoveredSummary =
        storedBaseline === null
          ? null
          : summarizeIgnoredContents(storedBaseline);
      const baselineMatchesState =
        recoveredSummary !== null &&
        recoveredSummary.length === input.ignoredBaseline.length &&
        recoveredSummary.every((entry) =>
          input.ignoredBaseline.some(
            (persisted) =>
              persisted.path === entry.path &&
              persisted.digest === entry.digest,
          ),
        );
      return classifyLaneDrift({
        entries,
        ignoredEntries,
        ownedPrefixes: union.ownedPrefixes,
        reservedPrefixes: [
          ...laneReservedPrefixes(input.memberContextIds),
          ...managedSkillsOwnedPaths,
        ],
        ignoredBaseline: input.ignoredBaseline,
        ignoredBaselineEntries:
          baselineMatchesState && storedBaseline !== null
            ? storedBaseline.entries
            : null,
        hasFullAccessMember: union.hasFullAccessMember,
      });
    },
  };
}
