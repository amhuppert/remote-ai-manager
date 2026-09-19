import {
  computeCandidateSnapshot as defaultComputeCandidateSnapshot,
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
 *  - observational `readOnly` scopes to nothing. A context with no write surface produces no
 *    changes, and whole-tree semantics would hand it every sibling's work — the
 *    read-only grade on the session lane is exactly where that is worst, since
 *    the session worktree carries everything running there. Structured handoff
 *    readers instead freeze the whole input tree and exclude concurrent writers.
 *
 * An absent placement is a context seeded before placement existed; whole-tree
 * is what it validated under, and nothing about it declares ownership to scope to.
 */
export function candidateScopeForPlacement(
  placement: ContextPlacement | undefined,
  options: { stableRead?: boolean } = {},
): CandidateScope {
  if (
    placement === undefined ||
    placement.mode === "full" ||
    (placement.mode === "readOnly" && options.stableRead)
  ) {
    return WHOLE_TREE_CANDIDATE_SCOPE;
  }
  return {
    mode: "owned",
    ownedPaths: placement.mode === "owned" ? placement.ownedPaths : [],
  };
}

/**
 * A retained context's change set, including self-commits, from its review
 * origin to one candidate snapshot. Identity and scope accompany the patch so
 * a validation round can prove it reviewed the candidate it froze.
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
  computeCandidateSnapshot(
    worktreePath: string,
    scope: CandidateScope,
    baselineSha: string,
  ): Promise<CandidateSnapshot | null>;
}

const defaultDeps: ValidationDiffScopeDeps = {
  computeCandidateSnapshot: (worktreePath, scope, baselineSha) =>
    defaultComputeCandidateSnapshot(
      worktreePath,
      scope,
      undefined,
      baselineSha,
    ),
};

function describeError(error: unknown): string {
  return getErrorMessage(error);
}

/**
 * A null origin is unavailable evidence, never a clean change set. Empty means
 * one successfully read candidate has the same scoped bytes as the baseline;
 * HEAD cleanliness cannot answer that after an implementer commits its work.
 */
export async function computeValidationDiffScope(
  worktreePath: string,
  candidateScope: CandidateScope = WHOLE_TREE_CANDIDATE_SCOPE,
  deps: ValidationDiffScopeDeps = defaultDeps,
  baselineSha: string | null = "HEAD",
): Promise<ValidationDiffScope> {
  if (baselineSha === null) {
    return {
      kind: "unavailable",
      candidateScope,
      reason: "the retained work has no captured review origin",
    };
  }

  let snapshot: CandidateSnapshot | null;
  try {
    snapshot = await deps.computeCandidateSnapshot(
      worktreePath,
      candidateScope,
      baselineSha,
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

  if (snapshot.diff.files.length === 0) {
    return { kind: "empty", candidateScope, treeHash: snapshot.treeHash };
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
      "These are the changes this context produced since its captured review origin, including committed and uncommitted work.",
      ...SHARED_INSTRUCTIONS,
    ].join("\n");
  }
  return [
    "These are the changes since this context’s captured review origin, including committed and uncommitted work, scoped to its frozen owned paths:",
    ...candidateScope.ownedPaths.map((ownedPath) => `- ${ownedPath}`),
    "This context runs under a file-ownership envelope and may write nothing else. Its worktree is shared with concurrent sibling contexts, whose changes are outside these owned paths and are deliberately absent below — do not fail this context for them, and do not read their absence as work this context left undone.",
    ...SHARED_INSTRUCTIONS,
  ].join("\n");
}

/** Hard ceilings so an oversized context can never blow the validator window. */
const HARD_MAX_PATCH_BYTES = 24_000;
const HARD_MAX_PATCH_LINES = 600;
export interface RenderedDiffScopeSection {
  section: string;
  truncated: boolean;
  includedFileCount: number;
  omittedFileCount: number;
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

  const byteBudget = HARD_MAX_PATCH_BYTES;
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
    if (fits) {
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
