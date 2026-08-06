import path from "node:path";

export type ScopeArgsViolationKind =
  | "empty_token"
  | "option_token"
  | "absolute_path"
  | "escapes_worktree";

export type ScopeArgsResult =
  | { ok: true; paths: string[] }
  | { ok: false; kind: ScopeArgsViolationKind; token: string };

/**
 * Validate tokens forwarded to a `scopeArgs: "paths"` validation command.
 *
 * Scope arguments may only narrow work: option tokens (which could raise
 * worker counts or swap configs and make real load exceed the declared
 * cost), absolute paths, and anything resolving outside the worktree are
 * rejected. Containment is purely lexical — the file need not exist, because
 * wrappers legitimately receive paths of just-deleted or renamed files and
 * decide themselves what to do with them.
 */
export function validateScopeArgs(
  tokens: readonly string[],
  worktreeRoot: string,
): ScopeArgsResult {
  const root = path.resolve(worktreeRoot);
  for (const token of tokens) {
    if (token.trim() === "") return { ok: false, kind: "empty_token", token };
    if (token.startsWith("-")) {
      return { ok: false, kind: "option_token", token };
    }
    if (path.isAbsolute(token)) {
      return { ok: false, kind: "absolute_path", token };
    }
    const resolved = path.resolve(root, token);
    // Segment-aware containment: `root + sep` prevents a sibling directory
    // that shares the worktree path as a string prefix from passing.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, kind: "escapes_worktree", token };
    }
  }
  return { ok: true, paths: [...tokens] };
}
