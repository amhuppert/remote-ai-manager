import type { RebaseOnto } from "@/lib/git/rebase";

/**
 * Parsed `/rebase` argument: where to rebase onto, plus a human label for
 * notices. `parseRebaseArgs` interprets the free-text hint that follows the
 * command:
 *
 *   /rebase                 → the session's configured target branch (local)
 *   /rebase main            → local branch `main`
 *   /rebase origin main     → branch `main` on remote `origin`
 */
export type ParsedRebaseArgs =
  | { ok: true; onto: RebaseOnto; label: string }
  | { ok: false; error: string };

export function parseRebaseArgs(
  hint: string,
  defaultTargetBranch: string,
): ParsedRebaseArgs {
  const tokens = hint.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) {
    return {
      ok: true,
      onto: { kind: "local", branch: defaultTargetBranch },
      label: defaultTargetBranch,
    };
  }

  if (tokens.length === 1) {
    const branch = tokens[0]!;
    return { ok: true, onto: { kind: "local", branch }, label: branch };
  }

  if (tokens.length === 2) {
    const [remote, branch] = tokens as [string, string];
    return {
      ok: true,
      onto: { kind: "remote", remote, branch },
      label: `${remote}/${branch}`,
    };
  }

  return {
    ok: false,
    error:
      "Usage: /rebase [<remote>] <branch> (e.g. /rebase main or /rebase origin main)",
  };
}
