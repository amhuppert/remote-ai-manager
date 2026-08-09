import path from "node:path";

export type PathArgsViolationKind =
  | "empty_token"
  | "option_token"
  | "absolute_path"
  | "escapes_worktree";

export type PathArgsResult =
  | { ok: true; paths: string[] }
  | { ok: false; kind: PathArgsViolationKind; token: string };

/**
 * Validate positional paths forwarded to a changed validation executable.
 *
 * Paths may only narrow work: option tokens, absolute paths, and anything
 * resolving outside the worktree are rejected. Containment is lexical so a
 * deleted or renamed path can still reach the wrapper for tool-level handling.
 */
export function validatePathArgs(
  tokens: readonly string[],
  worktreeRoot: string,
): PathArgsResult {
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
    // Segment-aware containment prevents a sibling that shares the worktree
    // path as a string prefix from passing.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, kind: "escapes_worktree", token };
    }
  }
  return { ok: true, paths: [...tokens] };
}
