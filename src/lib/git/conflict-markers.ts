/**
 * Conflict-artifact recognition shared by the git layer and its callers.
 *
 * Two complementary readings: git's own `--check` scan names candidate files
 * cheaply (changed lines only, no per-file reads), and the strict regex below
 * decides whether a candidate really carries a conflict.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultGitClient, type GitClient } from "./client";

/** A `git diff --check` finding line: `<path>:<line>: <message>`. */
const CHECK_FINDING = /^(.+?):\d+: (.+)$/;

const LEFTOVER_MARKER_MESSAGE = "leftover conflict marker";

/**
 * Whether text contains git conflict begin/end markers (`<<<<<<< `,
 * `>>>>>>> `, or the diff3 `||||||| ` base marker) at line start. The bare
 * `=======` separator is deliberately NOT matched — it appears standalone in
 * legitimate content (markdown setext headings, ini separators) and never
 * without a begin/end marker in a real conflict.
 */
export function containsConflictMarkers(content: string): boolean {
  return /^(<{7}|>{7}|\|{7}) /m.test(content);
}

/**
 * File paths `git diff --check` flagged for leftover conflict markers, in
 * first-seen order. Whitespace findings share the output stream and are not
 * conflict artifacts, so they are dropped.
 *
 * git's marker heuristic is broader than {@link containsConflictMarkers} — it
 * counts the bare `=======` separator — so the result is a candidate list to
 * confirm, not a verdict.
 */
export function parseCheckOutputMarkerFiles(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = CHECK_FINDING.exec(line.trimEnd());
    if (!match) continue;
    const [, file, message] = match;
    if (!file || message !== LEFTOVER_MARKER_MESSAGE) continue;
    if (!files.includes(file)) files.push(file);
  }
  return files;
}

/** A `-z` `git diff --numstat` record for a file git reads as binary:
 *  `-<TAB>-<TAB><path>`. Such a file never appears in `--check` output. */
const BINARY_NUMSTAT_RECORD = /^-\t-\t([\s\S]+)$/;

/** The `git status --porcelain -z` status pair for an untracked path. */
const UNTRACKED_STATUS_PREFIX = "?? ";

/** Output a git command wrote before failing, for commands that report
 *  findings on stdout and signal them with a non-zero exit. */
function stdoutOfFailure(err: unknown): string {
  if (
    typeof err === "object" &&
    err !== null &&
    "stdout" in err &&
    typeof err.stdout === "string"
  ) {
    return err.stdout;
  }
  return "";
}

/** What a worktree carries of an unfinished conflict, both readings. */
export interface ConflictArtifacts {
  /** Paths git still holds as unmerged index entries. */
  unmergedFiles: string[];
  /** Paths confirmed to carry begin/end conflict markers, from whatever the
   *  scan reached (see the two scan entrypoints below). */
  markerFiles: string[];
}

/**
 * Tracked paths whose change against HEAD could carry markers, in first-seen
 * order. `--check` is the cheap primary reading (changed lines only, no
 * per-file reads) but it answers for TEXT changes alone: a file carrying a NUL
 * byte is skipped by git's own scan, and an auto-merge can produce exactly
 * that — markers plus binary content — so the binary rows of `--numstat` are
 * read as candidates too.
 */
async function trackedMarkerCandidates(
  worktreePath: string,
  client: GitClient,
): Promise<string[]> {
  let checkOutput: string;
  try {
    const { stdout } = await client.git(
      ["diff", "HEAD", "--check"],
      worktreePath,
    );
    checkOutput = stdout;
  } catch (err) {
    // `--check` exits non-zero whenever it reports anything, including
    // whitespace-only findings, and on an unborn branch it fails with no
    // findings at all. Both are answered by parsing what it wrote.
    checkOutput = stdoutOfFailure(err);
  }
  const candidates = parseCheckOutputMarkerFiles(checkOutput);

  try {
    // `--no-renames` keeps every record's path inline, so a rename cannot
    // split one record across two `-z` fields.
    const { stdout } = await client.git(
      ["diff", "HEAD", "--numstat", "--no-renames", "-z"],
      worktreePath,
    );
    for (const record of stdout.split("\0")) {
      const path = BINARY_NUMSTAT_RECORD.exec(record)?.[1];
      if (path !== undefined && !candidates.includes(path)) {
        candidates.push(path);
      }
    }
  } catch {
    // Unborn branch: nothing is tracked, so nothing binary changed either.
  }

  return candidates;
}

/** Paths git reports as untracked (ignored paths excluded). */
async function untrackedPaths(
  worktreePath: string,
  client: GitClient,
): Promise<string[]> {
  const { stdout } = await client.git(
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    worktreePath,
  );
  const paths: string[] = [];
  for (const record of stdout.split("\0")) {
    if (!record.startsWith(UNTRACKED_STATUS_PREFIX)) continue;
    const path = record.slice(UNTRACKED_STATUS_PREFIX.length);
    if (path.length > 0 && !paths.includes(path)) paths.push(path);
  }
  return paths;
}

/**
 * Candidates confirmed against {@link containsConflictMarkers}. Every
 * candidate reading is broader than a conflict — git's `--check` heuristic
 * counts a bare `=======` separator, and the binary and untracked readings
 * flag on reachability alone — so the file itself decides. Unreadable
 * candidates are skipped: a path that cannot be read cannot be shown to carry
 * a conflict.
 */
async function confirmMarkerFiles(
  worktreePath: string,
  candidates: string[],
): Promise<string[]> {
  const markerFiles: string[] = [];
  for (const file of candidates) {
    let content: string;
    try {
      content = await readFile(join(worktreePath, file), "utf-8");
    } catch {
      continue;
    }
    if (containsConflictMarkers(content)) markerFiles.push(file);
  }
  return markerFiles;
}

async function readUnmergedFiles(
  worktreePath: string,
  client: GitClient,
): Promise<string[]> {
  const { stdout } = await client.git(
    ["diff", "--name-only", "--diff-filter=U"],
    worktreePath,
  );
  return stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

/**
 * What the MERGE ITSELF still carries: unmerged entries plus markers in the
 * tracked changes git can diff against HEAD.
 *
 * Unmerged entries answer for a tree git itself still calls conflicted; the
 * marker scan answers for the poisoned tree an index resync leaves behind,
 * where MERGE_HEAD and the unmerged entries are gone but the markers are still
 * in the files. Untracked paths are deliberately outside this reading: a
 * scratch or `.orig` backup file full of markers says nothing about whether
 * the merge is resolved, and reading it as "unresolved" would let a caller
 * abort a finished hand-resolution.
 */
export async function scanConflictArtifacts(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<ConflictArtifacts> {
  const unmergedFiles = await readUnmergedFiles(worktreePath, client);
  const candidates = await trackedMarkerCandidates(worktreePath, client);
  return {
    unmergedFiles,
    markerFiles: await confirmMarkerFiles(worktreePath, candidates),
  };
}

/**
 * What a `git add -A` commit would CAPTURE: the merge's own artifacts plus
 * markers in untracked files, which staging sweeps in even though no diff
 * against HEAD mentions them.
 *
 * This is the reading a commit guard needs — the question is not "is the merge
 * resolved" but "could this commit carry conflict artifacts".
 */
export async function scanStagingConflictArtifacts(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<ConflictArtifacts> {
  const unmergedFiles = await readUnmergedFiles(worktreePath, client);
  const candidates = await trackedMarkerCandidates(worktreePath, client);
  for (const path of await untrackedPaths(worktreePath, client)) {
    if (!candidates.includes(path)) candidates.push(path);
  }
  return {
    unmergedFiles,
    markerFiles: await confirmMarkerFiles(worktreePath, candidates),
  };
}

/**
 * State of an unconcluded `git merge` in a worktree.
 *
 * `resolved` is the shape that must never be discarded: MERGE_HEAD is still
 * set but nothing conflicts any more, which is what a human's finished
 * hand-resolution looks like in the window before they commit it. Aborting
 * there throws that work away.
 */
export type InProgressMergeState =
  | { kind: "none" }
  | { kind: "unresolved"; artifacts: ConflictArtifacts }
  | { kind: "resolved" };

/**
 * Whether the worktree holds an unconcluded merge. The one MERGE_HEAD probe:
 * every caller that asks "is a merge open here" — the commit guard, the abort,
 * the classifier below — reads the same answer the same way.
 */
export async function isMergeInProgress(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<boolean> {
  try {
    await client.git(
      ["rev-parse", "-q", "--verify", "MERGE_HEAD"],
      worktreePath,
    );
    return true;
  } catch {
    return false;
  }
}

/** Classify an unconcluded merge in `worktreePath`. */
export async function inspectInProgressMerge(
  worktreePath: string,
  client: GitClient = defaultGitClient,
): Promise<InProgressMergeState> {
  if (!(await isMergeInProgress(worktreePath, client))) return { kind: "none" };
  const artifacts = await scanConflictArtifacts(worktreePath, client);
  if (artifacts.unmergedFiles.length > 0 || artifacts.markerFiles.length > 0) {
    return { kind: "unresolved", artifacts };
  }
  return { kind: "resolved" };
}
