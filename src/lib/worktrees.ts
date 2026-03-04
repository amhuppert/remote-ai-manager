import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { getErrorMessage } from "@/lib/errors";
import type { SessionState } from "@/types";
import { mutateState } from "./state";
import { createLogger } from "./logging";

const logger = createLogger("worktrees");

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parsed worktree entry from git porcelain output */
export interface DiscoveredWorktree {
  /** Absolute path to the worktree */
  path: string;
  /** HEAD commit SHA */
  head: string;
  /** Branch name (null if detached HEAD) */
  branch: string | null;
  /** True if this is the main working tree (first entry in porcelain output) */
  isMainWorktree: boolean;
}

/** Result of worktree reconciliation */
export interface ReconciliationResult {
  /** Sessions imported during this reconciliation */
  imported: SessionState[];
  /** Names of sessions in state whose worktree no longer exists on disk */
  orphanedSessionNames: string[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse `git worktree list --porcelain` output into structured entries.
 *
 * Porcelain format: blocks separated by blank lines.
 * Each block contains:
 *   worktree <path>
 *   HEAD <sha>
 *   branch refs/heads/<name>   OR   detached
 *   [locked [<reason>]]
 *   [prunable <reason>]
 *   [bare]
 *
 * The first block is always the main working tree.
 */
export function parseWorktreeList(
  porcelainOutput: string,
): DiscoveredWorktree[] {
  const trimmed = porcelainOutput.trim();
  if (!trimmed) return [];

  const blocks = trimmed.split(/\n\n+/);
  const result: DiscoveredWorktree[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const lines = block.split("\n");

    let wtPath: string | undefined;
    let head: string | undefined;
    let branch: string | null = null;
    let isDetached = false;

    for (const line of lines) {
      if (line.startsWith("worktree ")) {
        wtPath = line.slice("worktree ".length);
      } else if (line.startsWith("HEAD ")) {
        head = line.slice("HEAD ".length);
      } else if (line.startsWith("branch ")) {
        branch = line.slice("branch ".length);
      } else if (line === "detached") {
        isDetached = true;
        branch = null;
      }
      // "locked", "prunable", "bare" are ignored (not needed for import)
    }

    // Skip entries missing required fields
    if (!wtPath || !head) continue;
    if (!isDetached && branch === null) continue;

    result.push({
      path: wtPath,
      head,
      branch,
      isMainWorktree: i === 0,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Name derivation
// ---------------------------------------------------------------------------

/**
 * Derive a session display name from a worktree.
 * Strips `refs/heads/` and `csm/` prefixes from branch name.
 * Falls back to directory basename for detached HEAD.
 */
export function deriveSessionName(worktree: DiscoveredWorktree): string {
  if (worktree.branch) {
    let name = worktree.branch;
    // Strip refs/heads/ prefix (git porcelain convention)
    if (name.startsWith("refs/heads/")) {
      name = name.slice("refs/heads/".length);
    }
    // Strip csm/ prefix (branch naming convention)
    if (name.startsWith("csm/")) {
      name = name.slice("csm/".length);
    }
    return name;
  }

  // Detached HEAD: use directory basename
  return path.basename(worktree.path);
}

/**
 * Ensure a session name is unique within a project's existing sessions.
 * Appends numeric suffix (e.g., `name-2`, `name-3`) if needed.
 */
export function ensureUniqueName(
  baseName: string,
  existingNames: Set<string>,
): string {
  if (!existingNames.has(baseName)) return baseName;

  let suffix = 2;
  while (existingNames.has(`${baseName}-${suffix}`)) {
    suffix++;
  }
  return `${baseName}-${suffix}`;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

/**
 * Discover worktrees on disk, reconcile against state, and import untracked ones.
 *
 * - Runs `git worktree list --porcelain` in projectPath
 * - Filters out the main working tree
 * - Matches discovered worktrees against existing sessions by worktreePath
 * - Creates SessionState records for untracked worktrees (source: "imported")
 * - Identifies orphaned sessions (in state but worktree missing, not finished)
 * - Persists new sessions atomically
 *
 * On git failure, logs the error and returns empty result.
 */
export async function discoverAndImportWorktrees(
  projectPath: string,
  existingSessions: SessionState[],
): Promise<ReconciliationResult> {
  // Run git worktree list
  let porcelainOutput: string;
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["worktree", "list", "--porcelain"],
      {
        cwd: projectPath,
      },
    );
    porcelainOutput = stdout;
  } catch (err) {
    logger.error("worktrees.discovery_failure", {
      projectPath,
      error: getErrorMessage(err),
    });
    return { imported: [], orphanedSessionNames: [] };
  }

  // Parse and filter out main worktree
  const discovered = parseWorktreeList(porcelainOutput).filter(
    (wt) => !wt.isMainWorktree,
  );

  // Build lookups of existing sessions by worktreePath and branchName
  const existingByPath = new Set(existingSessions.map((s) => s.worktreePath));
  const existingNames = new Set(existingSessions.map((s) => s.sessionName));
  const existingByBranch = new Set(
    existingSessions.map((s) => s.branchName).filter(Boolean),
  );

  // Identify untracked worktrees (defense-in-depth: also match by branch name
  // to prevent importing a worktree that was just created but whose path in
  // state differs slightly from the discovered path)
  const untracked = discovered.filter((wt) => {
    if (existingByPath.has(wt.path)) return false;
    if (wt.branch) {
      let branch = wt.branch;
      if (branch.startsWith("refs/heads/"))
        branch = branch.slice("refs/heads/".length);
      if (existingByBranch.has(branch)) return false;
    }
    return true;
  });

  // Identify orphaned sessions
  const discoveredPaths = new Set(discovered.map((wt) => wt.path));
  const orphanedSessionNames = existingSessions
    .filter(
      (s) =>
        !s.finished &&
        !discoveredPaths.has(s.worktreePath) &&
        !existsSync(s.worktreePath),
    )
    .map((s) => s.sessionName);

  // Import untracked worktrees
  if (untracked.length === 0) {
    logger.info("worktrees.reconciliation", {
      projectPath,
      discovered: discovered.length,
      imported: 0,
      orphaned: orphanedSessionNames.length,
    });
    return { imported: [], orphanedSessionNames };
  }

  const now = new Date().toISOString();
  const imported: SessionState[] = [];

  // Track names as we go to avoid conflicts between imports themselves
  const usedNames = new Set(existingNames);

  for (const wt of untracked) {
    const baseName = deriveSessionName(wt);
    const sessionName = ensureUniqueName(baseName, usedNames);
    usedNames.add(sessionName);

    // Strip refs/heads/ for branchName field
    let branchName = wt.branch ?? "";
    if (branchName.startsWith("refs/heads/")) {
      branchName = branchName.slice("refs/heads/".length);
    }

    imported.push({
      sessionName,
      worktreePath: wt.path,
      branchName,
      createdAt: now,
      lastActivityAt: now,
      archived: false,
      finished: false,
      conversations: [],
      source: "imported",
      objective: null,
      creationMode: "fast",
      workflow: null,
    });
  }

  // Persist atomically
  await mutateState("reconcileWorktrees", (state) => {
    if (!state.projects[projectPath]) {
      state.projects[projectPath] = {
        rootPath: projectPath,
        sessions: {},
        roadmapItems: [],
      };
    }

    const project = state.projects[projectPath]!;
    for (const session of imported) {
      project.sessions[session.sessionName] = session;
    }
  });

  logger.info("worktrees.reconciliation", {
    projectPath,
    discovered: discovered.length,
    imported: imported.length,
    orphaned: orphanedSessionNames.length,
  });

  return { imported, orphanedSessionNames };
}
