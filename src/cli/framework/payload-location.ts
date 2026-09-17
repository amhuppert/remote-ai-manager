import path from "node:path";

export interface ClientAdvisory {
  /** The recorded failure that earned this reminder (admission rule). */
  evidence: string;
  /** The reminder body: one line, no tier prefix — the renderer owns both. */
  reminder(subject: string): string;
}

/**
 * The complete set of CLIENT-authored reminders. Reminders are otherwise
 * server-authored (steering `cli.md`): the server holds the state that decides
 * whether an invariant is worth repeating. These are the enumerated exception —
 * invariants about the caller's own filesystem, which no server can observe.
 * Adding an entry is an edit to this list, with its evidence, in review.
 */
export const CLIENT_ADVISORIES = {
  payload_outside_cc: {
    evidence:
      "A graph-workflow lane commits its whole worktree ('git add -A') at land time, so a payload left at the worktree root landed in the diff its context validator reviewed and derailed the context.",
    reminder: (filePath: string) =>
      `"${filePath}" is outside .cc/ — author cctl payload files under .cc/temp/ so a lane commit ('git add -A') doesn't sweep them into the branch`,
  },
} satisfies Record<string, ClientAdvisory>;

/**
 * The payload-location reminder for a file a lane commit could sweep into the
 * branch, or undefined when the path is not at risk. File-backed payloads (plan
 * / inputs / questions / doc / charter JSON) are throwaway scratch, and CC's
 * `.cc/` namespace is git-ignored, so `.cc/temp/` is their safe home.
 *
 * Only worktree-relative paths outside `.cc/` qualify: a relative path resolves
 * against the agent's cwd (always its worktree), so it is exactly a file at
 * risk. Absolute paths (the worktree root is unknown to the CLI here) and stdin
 * (`-`) are out of scope — the observed footgun is the documented bare
 * `--file doc.json`.
 */
export function ccTempPayloadAdvisory(filePath: string): string | undefined {
  if (filePath === "-" || path.isAbsolute(filePath)) return undefined;
  const segments = path.normalize(filePath).split(path.sep);
  if (segments.includes(".cc")) return undefined;
  return CLIENT_ADVISORIES.payload_outside_cc.reminder(filePath);
}
