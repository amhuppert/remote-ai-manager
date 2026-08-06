import {
  computeCandidateSnapshot as defaultComputeCandidateSnapshot,
  type CandidateSnapshot,
} from "@/lib/git/diff";
import { hasUncommittedChanges as defaultHasUncommittedChanges } from "@/lib/git/commits";
import type { FileDiff, SessionDiff } from "@/lib/git/schemas";
import { getErrorMessage } from "@/lib/shared/errors";

/**
 * The change set a context validator reviews. Computed from the validator's
 * worktree just before its turn. Because the engine commits each context once
 * at land time (and never mid-iteration), the uncommitted working-tree delta
 * against HEAD at validation time is exactly the current context's changes.
 *
 * `treeHash` is the identity of the tree the patch was read from. It travels
 * with the scope so a validation round can prove the bytes it showed reviewers
 * came from the tree it froze, rather than trusting that two independent probes
 * of the same worktree happened to agree.
 */
export type ValidationDiffScope =
  | {
      kind: "available";
      treeHash: string;
      diff: SessionDiff;
      fileCount: number;
      totalAdditions: number;
      totalDeletions: number;
    }
  | { kind: "empty"; treeHash: string }
  | { kind: "unavailable"; reason: string };

export interface ValidationDiffScopeDeps {
  /**
   * Read the candidate's tree hash and its patch against HEAD from ONE
   * temporary index. Not `computeDiff`: that result is cached on HEAD plus a
   * porcelain hash, which cannot see a content-only edit to an already-modified
   * file, so it can hand back a patch older than the tree a round froze.
   */
  computeCandidateSnapshot(
    worktreePath: string,
  ): Promise<CandidateSnapshot | null>;
  /** Cheap porcelain probe; throws when git itself is unavailable. */
  hasUncommittedChanges(worktreePath: string): Promise<boolean>;
}

const defaultDeps: ValidationDiffScopeDeps = {
  computeCandidateSnapshot: defaultComputeCandidateSnapshot,
  hasUncommittedChanges: defaultHasUncommittedChanges,
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
 */
export async function computeValidationDiffScope(
  worktreePath: string,
  deps: ValidationDiffScopeDeps = defaultDeps,
): Promise<ValidationDiffScope> {
  let dirty: boolean;
  try {
    dirty = await deps.hasUncommittedChanges(worktreePath);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `status probe failed: ${describeError(error)}`,
    };
  }

  let snapshot: CandidateSnapshot | null;
  try {
    snapshot = await deps.computeCandidateSnapshot(worktreePath);
  } catch (error) {
    return {
      kind: "unavailable",
      reason: `diff computation failed: ${describeError(error)}`,
    };
  }

  if (snapshot === null) {
    return {
      kind: "unavailable",
      reason: "the candidate tree could not be read",
    };
  }

  if (!dirty) {
    return { kind: "empty", treeHash: snapshot.treeHash };
  }

  if (snapshot.diff.files.length === 0) {
    return {
      kind: "unavailable",
      reason: "working tree is dirty but no diff could be produced",
    };
  }

  return {
    kind: "available",
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

const INSTRUCTIONS = [
  "These are the uncommitted changes this context produced (working tree vs HEAD).",
  "Start your review here: inspect the changed files first, and consult the wider tree only when judging integration or acceptance-criteria impact.",
  "Do not fail the context for unrelated pre-existing issues outside this diff.",
  "Do fail when the diff introduces, leaves incomplete, or otherwise fails to satisfy behavior required by this context's acceptance criteria.",
].join("\n");

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
        "This context produced no file changes. Validate the completed tasks against the acceptance criteria using their stored summaries.",
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
    INSTRUCTIONS,
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
