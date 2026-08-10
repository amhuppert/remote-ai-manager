import {
  computeCandidateSnapshot as defaultComputeCandidateSnapshot,
  hasCandidateScopeChanges as defaultHasCandidateScopeChanges,
  WHOLE_TREE_CANDIDATE_SCOPE,
  type CandidateScope,
  type CandidateSnapshot,
} from "@/lib/git/diff";
import type { FileDiff, SessionDiff } from "@/lib/git/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ContextPlacement } from "./definition-schemas";

/**
 * The candidate scope a context's authored placement implies (R15).
 *
 * The three grades map to two readings, and which one a member gets is decided
 * here so the freeze, the re-read, and the validator's rendering cannot disagree
 * about it:
 *  - `full` keeps whole-tree semantics. A full-access member holds its lane
 *    alone against every other write-capable member, so the whole worktree delta
 *    IS its change set;
 *  - `owned` scopes to the declared paths. Its lane worktree is shared with
 *    concurrent siblings, so the whole-tree delta is partly theirs;
 *  - `readOnly` scopes to nothing. A context with no write surface produces no
 *    changes, and whole-tree semantics would hand it every sibling's work — the
 *    read-only grade on the session lane is exactly where that is worst, since
 *    the session worktree carries everything running there.
 *
 * An absent placement is a context seeded before placement existed; whole-tree
 * is what it validated under, and nothing about it declares ownership to scope to.
 */
export function candidateScopeForPlacement(
  placement: ContextPlacement | undefined,
): CandidateScope {
  if (placement === undefined || placement.mode === "full") {
    return WHOLE_TREE_CANDIDATE_SCOPE;
  }
  return {
    mode: "owned",
    ownedPaths: placement.mode === "owned" ? placement.ownedPaths : [],
  };
}

/**
 * The change set a context validator reviews. Computed from the validator's
 * worktree just before its turn. Because the engine commits each context once
 * at land time (and never mid-iteration), the uncommitted working-tree delta
 * against HEAD at validation time is exactly the current context's changes —
 * restricted, for an enveloped context, to the paths that context owns.
 *
 * `treeHash` is the identity of the candidate the patch was read from. It
 * travels with the scope so a validation round can prove the bytes it showed
 * reviewers came from the candidate it froze, rather than trusting that two
 * independent probes of the same worktree happened to agree.
 *
 * `candidateScope` travels with it too, because the two are only meaningful
 * together: the same worktree yields different patches and different identities
 * under different ownership, so a reader that lost the scope could not say what
 * the identity was an identity OF.
 */
export type ValidationDiffScope =
  | {
      kind: "available";
      candidateScope: CandidateScope;
      treeHash: string;
      diff: SessionDiff;
      fileCount: number;
      totalAdditions: number;
      totalDeletions: number;
    }
  | { kind: "empty"; candidateScope: CandidateScope; treeHash: string }
  | { kind: "unavailable"; candidateScope: CandidateScope; reason: string };

export interface ValidationDiffScopeDeps {
  /**
   * Read the candidate's identity and its patch against HEAD from ONE temporary
   * index, both restricted to the same scope. Not `computeDiff`: that result is
   * cached on HEAD plus a porcelain hash, which cannot see a content-only edit
   * to an already-modified file, so it can hand back a patch older than the
   * candidate a round froze.
   */
  computeCandidateSnapshot(
    worktreePath: string,
    scope: CandidateScope,
  ): Promise<CandidateSnapshot | null>;
  /** Cheap scoped porcelain probe; throws when git itself is unavailable. */
  hasUncommittedChanges(
    worktreePath: string,
    scope: CandidateScope,
  ): Promise<boolean>;
}

const defaultDeps: ValidationDiffScopeDeps = {
  computeCandidateSnapshot: defaultComputeCandidateSnapshot,
  hasUncommittedChanges: defaultHasCandidateScopeChanges,
};

function describeError(error: unknown): string {
  return getErrorMessage(error);
}

/**
 * Resolve the validator's change-set scope for the given worktree.
 *
 * An independent `git status --porcelain` probe (via `hasUncommittedChanges`)
 * tells a genuinely clean tree apart from a degraded read:
 * - probe throws → git unavailable → `unavailable`
 * - snapshot unreadable → `unavailable`
 * - probe clean → genuine no-op context → `empty` (still carrying its identity)
 * - probe dirty + non-empty diff → `available`
 * - probe dirty + empty diff → degraded → `unavailable`
 *
 * The probe is scoped alongside the snapshot, not left whole-tree. An unscoped
 * probe in a shared lane worktree would call the tree dirty on a sibling's
 * writes, find nothing inside this context's ownership to show for it, and
 * report a clean owned subset as a degraded read.
 */
export async function computeValidationDiffScope(
  worktreePath: string,
  candidateScope: CandidateScope = WHOLE_TREE_CANDIDATE_SCOPE,
  deps: ValidationDiffScopeDeps = defaultDeps,
): Promise<ValidationDiffScope> {
  let dirty: boolean;
  try {
    dirty = await deps.hasUncommittedChanges(worktreePath, candidateScope);
  } catch (error) {
    return {
      kind: "unavailable",
      candidateScope,
      reason: `status probe failed: ${describeError(error)}`,
    };
  }

  let snapshot: CandidateSnapshot | null;
  try {
    snapshot = await deps.computeCandidateSnapshot(
      worktreePath,
      candidateScope,
    );
  } catch (error) {
    return {
      kind: "unavailable",
      candidateScope,
      reason: `diff computation failed: ${describeError(error)}`,
    };
  }

  if (snapshot === null) {
    return {
      kind: "unavailable",
      candidateScope,
      reason: "the candidate tree could not be read",
    };
  }

  if (!dirty) {
    return { kind: "empty", candidateScope, treeHash: snapshot.treeHash };
  }

  if (snapshot.diff.files.length === 0) {
    return {
      kind: "unavailable",
      candidateScope,
      reason: "working tree is dirty but no diff could be produced",
    };
  }

  return {
    kind: "available",
    candidateScope,
    treeHash: snapshot.treeHash,
    diff: snapshot.diff,
    fileCount: snapshot.diff.files.length,
    totalAdditions: snapshot.diff.totalAdditions,
    totalDeletions: snapshot.diff.totalDeletions,
  };
}

/**
 * The identity of the tree a scope was read from, or null when it could not be
 * read at all. A round compares this against its frozen candidate.
 */
export function diffScopeTreeHash(scope: ValidationDiffScope): string | null {
  return scope.kind === "unavailable" ? null : scope.treeHash;
}

const HEADER = "## Changes Under Review";

const SHARED_INSTRUCTIONS = [
  "Start your review here: inspect the changed files first, and consult the wider tree only when judging integration or acceptance-criteria impact.",
  "Do not fail the context for unrelated pre-existing issues outside this diff.",
  "Do fail when the diff introduces, leaves incomplete, or otherwise fails to satisfy behavior required by this context's acceptance criteria.",
];

/**
 * What the validator has to be told about the scope, because a scoped diff is
 * indistinguishable from an incomplete one otherwise.
 *
 * An enveloped context shares its lane worktree with concurrent siblings, so its
 * diff deliberately omits their work. A validator that did not know the diff was
 * ownership-scoped could read a collaborator's absent change as this context's
 * omission and fail it for work it was never allowed to write.
 */
function renderInstructions(candidateScope: CandidateScope): string {
  if (candidateScope.mode === "wholeTree") {
    return [
      "These are the uncommitted changes this context produced (working tree vs HEAD).",
      ...SHARED_INSTRUCTIONS,
    ].join("\n");
  }
  return [
    "These are the uncommitted changes this context produced (working tree vs HEAD), scoped to the paths this context owns:",
    ...candidateScope.ownedPaths.map((ownedPath) => `- ${ownedPath}`),
    "This context runs under a file-ownership envelope and may write nothing else. Its worktree is shared with concurrent sibling contexts, whose changes are outside these owned paths and are deliberately absent below — do not fail this context for them, and do not read their absence as work this context left undone.",
    ...SHARED_INSTRUCTIONS,
  ].join("\n");
}

/** Hard ceilings so an oversized context can never blow the validator window. */
const HARD_MAX_PATCH_BYTES = 24_000;
const HARD_MAX_PATCH_LINES = 600;
/** Inline-patch share of the context window, in bytes-per-token terms. */
const PATCH_TOKEN_FRACTION = 0.25;
const BYTES_PER_TOKEN = 4;

export interface DiffScopeBudget {
  /** Validator `continuity.contextLimitTokens`, when configured. */
  contextLimitTokens?: number;
}

export interface RenderedDiffScopeSection {
  section: string;
  truncated: boolean;
  includedFileCount: number;
  omittedFileCount: number;
}

function resolveByteBudget(budget: DiffScopeBudget): number {
  if (budget.contextLimitTokens && budget.contextLimitTokens > 0) {
    const derived = Math.floor(
      budget.contextLimitTokens * BYTES_PER_TOKEN * PATCH_TOKEN_FRACTION,
    );
    return Math.max(0, Math.min(HARD_MAX_PATCH_BYTES, derived));
  }
  return HARD_MAX_PATCH_BYTES;
}

function renderDiffstat(diff: SessionDiff): string {
  return [
    `Files changed: ${diff.files.length} (+${diff.totalAdditions} -${diff.totalDeletions} total)`,
    ...diff.files.map(
      (file) => `- ${file.filePath} (+${file.additions} -${file.deletions})`,
    ),
  ].join("\n");
}

function renderFilePatch(file: FileDiff): string {
  const lines: string[] = [`--- a/${file.filePath}`, `+++ b/${file.filePath}`];
  for (const hunk of file.hunks) {
    for (const line of hunk.lines) {
      if (line.type === "hunk-header") {
        lines.push(line.content);
      } else if (line.type === "add") {
        lines.push(`+${line.content}`);
      } else if (line.type === "remove") {
        lines.push(`-${line.content}`);
      } else {
        lines.push(` ${line.content}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Render the prompt section for a resolved scope. Pure: no git, no I/O — the
 * full diffstat is always included, unified hunks are included up to a hard
 * byte/line budget, and any omission is disclosed explicitly so the validator
 * knows to read the omitted files on demand.
 */
export function renderDiffScopeSection(
  scope: ValidationDiffScope,
  budget: DiffScopeBudget = {},
): RenderedDiffScopeSection {
  if (scope.kind === "unavailable") {
    return {
      section: [
        HEADER,
        "",
        `Diff scope unavailable (${scope.reason}). Review the completed tasks against the acceptance criteria by inspecting the worktree directly.`,
      ].join("\n"),
      truncated: false,
      includedFileCount: 0,
      omittedFileCount: 0,
    };
  }

  if (scope.kind === "empty") {
    return {
      section: [
        HEADER,
        "",
        scope.candidateScope.mode === "owned"
          ? `This context produced no file changes inside the paths it owns${scope.candidateScope.ownedPaths.length > 0 ? ` (${scope.candidateScope.ownedPaths.join(", ")})` : " (it owns none)"}, which is the whole of its change set — concurrent sibling contexts may have changed the shared worktree elsewhere, and none of that is this context's work. Validate the completed tasks against the acceptance criteria using their stored summaries.`
          : "This context produced no file changes. Validate the completed tasks against the acceptance criteria using their stored summaries.",
      ].join("\n"),
      truncated: false,
      includedFileCount: 0,
      omittedFileCount: 0,
    };
  }

  const byteBudget = resolveByteBudget(budget);
  const parts: string[] = [
    HEADER,
    "",
    renderInstructions(scope.candidateScope),
    "",
    "### Diff stat",
    "",
    renderDiffstat(scope.diff),
  ];

  const includedPatches: string[] = [];
  const omittedFiles: string[] = [];
  let usedBytes = 0;
  let usedLines = 0;
  let stopped = false;

  for (const file of scope.diff.files) {
    if (stopped) {
      omittedFiles.push(file.filePath);
      continue;
    }
    const patch = renderFilePatch(file);
    const patchBytes = Buffer.byteLength(patch, "utf8");
    const patchLines = patch.split("\n").length;
    const fits =
      usedBytes + patchBytes <= byteBudget &&
      usedLines + patchLines <= HARD_MAX_PATCH_LINES;
    // Always include the first file so a real change never renders hunk-less.
    if (includedPatches.length === 0 || fits) {
      includedPatches.push(patch);
      usedBytes += patchBytes;
      usedLines += patchLines;
    } else {
      omittedFiles.push(file.filePath);
      stopped = true;
    }
  }

  if (includedPatches.length > 0) {
    parts.push(
      "",
      "### Diff",
      "",
      "```diff",
      includedPatches.join("\n"),
      "```",
    );
  }

  const truncated = omittedFiles.length > 0;
  if (truncated) {
    parts.push(
      "",
      "### Truncation notice",
      "",
      `The diff exceeded the inline budget. ${omittedFiles.length} changed file(s) appear in the diff stat above but their patches were omitted here — read them directly in the worktree when their correctness bears on the acceptance criteria:`,
      ...omittedFiles.map((file) => `- ${file}`),
    );
  }

  return {
    section: parts.join("\n"),
    truncated,
    includedFileCount: includedPatches.length,
    omittedFileCount: omittedFiles.length,
  };
}
