/**
 * Pure worktree-relative document-path normalization. No `node:path` (which
 * resolves relative inputs against `process.cwd()` and would not be pure, nor
 * bundle cleanly client-side) — resolution is explicit segment arithmetic
 * against the caller-supplied `worktreeRoot`, so these helpers are pure and run
 * identically on the server and in the browser (the file-card refs use them at
 * render time). POSIX paths only (Command Center runs on darwin/linux).
 */

export type NormalizeDocPathResult =
  | { ok: true; docPath: string }
  | { ok: false; reason: "non-markdown" | "traversal" | "outside-worktree" };

/** A markdown path ends in `.md` (case-insensitive). `.mdx` is not markdown. */
export function isMarkdownPath(p: string): boolean {
  return /\.md$/i.test(p);
}

function splitSegments(p: string): string[] {
  return p.split("/");
}

/**
 * Collapse `.`/empty segments and resolve `..` for a RELATIVE path. Returns
 * null if any `..` would escape above the root — that is a traversal attempt.
 */
function resolveRelativeSegments(segments: string[]): string[] | null {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/**
 * Collapse `.`/empty segments and resolve `..` for an ABSOLUTE path. `..` at the
 * filesystem root is a no-op (cannot escape `/`), matching POSIX resolution.
 */
function resolveAbsoluteSegments(segments: string[]): string[] {
  const out: string[] = [];
  for (const seg of segments) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

/**
 * Resolve any document path reference to a worktree-relative `.md` `docPath`.
 *
 * - An absolute path INSIDE the worktree normalizes to its relative `docPath`.
 * - An absolute path OUTSIDE the worktree (or one that resolves outside via
 *   `..`) is `outside-worktree` (the viewer/file-card shows "unavailable").
 * - A relative path that escapes the worktree via `..` is `traversal`.
 * - A non-`.md` path is `non-markdown`.
 */
export function normalizeDocPath(
  input: string,
  worktreeRoot: string,
): NormalizeDocPathResult {
  const trimmed = input.trim();
  if (trimmed.length === 0 || !isMarkdownPath(trimmed)) {
    return { ok: false, reason: "non-markdown" };
  }

  if (trimmed.startsWith("/")) {
    const rootSegs = resolveAbsoluteSegments(splitSegments(worktreeRoot));
    const inputSegs = resolveAbsoluteSegments(splitSegments(trimmed));
    if (inputSegs.length <= rootSegs.length) {
      return { ok: false, reason: "outside-worktree" };
    }
    for (let i = 0; i < rootSegs.length; i++) {
      if (inputSegs[i] !== rootSegs[i]) {
        return { ok: false, reason: "outside-worktree" };
      }
    }
    return { ok: true, docPath: inputSegs.slice(rootSegs.length).join("/") };
  }

  const segs = resolveRelativeSegments(splitSegments(trimmed));
  if (segs === null) return { ok: false, reason: "traversal" };
  if (segs.length === 0) return { ok: false, reason: "non-markdown" };
  return { ok: true, docPath: segs.join("/") };
}

/**
 * Join a worktree-relative `.md` `docPath` onto `worktreeRoot`, returning the
 * absolute on-disk path — or null if the path is non-markdown or escapes the
 * worktree via `..`. The content endpoint uses this as the final read guard.
 */
export function resolveWithinWorktree(
  docPath: string,
  worktreeRoot: string,
): string | null {
  if (!isMarkdownPath(docPath)) return null;
  const segs = resolveRelativeSegments(splitSegments(docPath));
  if (segs === null || segs.length === 0) return null;
  const root = worktreeRoot.replace(/\/+$/, "");
  return [root, ...segs].join("/");
}
