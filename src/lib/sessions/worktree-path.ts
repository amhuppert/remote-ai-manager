/**
 * Shorten an absolute worktree path to the portion after the `.worktrees/`
 * marker for compact display. Returns the original path when the marker is
 * absent. The full path should still be used as the clipboard value.
 */
export function shortenWorktreePath(fullPath: string): string {
  const marker = ".worktrees/";
  const idx = fullPath.indexOf(marker);
  if (idx === -1) return fullPath;
  return fullPath.slice(idx + marker.length);
}
