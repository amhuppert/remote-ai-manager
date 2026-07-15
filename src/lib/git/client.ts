/**
 * Shared GitClient interface for executing git commands.
 *
 * Replaces the 3 duplicate `git()` / `execFileAsync("git", ...)` wrappers
 * in git-operations.ts, sessions.ts, and worktrees.ts.
 *
 * Tests can inject a fake GitClient to avoid mocking node:child_process.
 */

import { execFile } from "../shared/exec";
import { buildChildEnv } from "../shared/child-env";

interface GitResult {
  stdout: string;
  stderr: string;
}

export interface GitClient {
  /**
   * Execute a git command with the given args in the given working directory.
   *
   * `env` entries are merged on top of the sanitized child env AFTER inherited
   * git vars are stripped, so a caller can scope a command to e.g. a temporary
   * `GIT_INDEX_FILE` without re-exposing whatever the parent process inherited.
   */
  git(
    args: string[],
    cwd: string,
    options?: { maxBuffer?: number; env?: Record<string, string> },
  ): Promise<GitResult>;
}

/** Default GitClient implementation backed by the timed exec wrapper. */
class ExecFileGitClient implements GitClient {
  async git(
    args: string[],
    cwd: string,
    options?: { maxBuffer?: number; env?: Record<string, string> },
  ): Promise<GitResult> {
    return execFile("git", args, {
      cwd,
      maxBuffer: options?.maxBuffer,
      env: options?.env
        ? { ...buildChildEnv(), ...options.env }
        : buildChildEnv(),
      eventPrefix: "git",
    });
  }
}

/** Shared default instance for production use. */
export const defaultGitClient: GitClient = new ExecFileGitClient();
