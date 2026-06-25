/**
 * Pure, client-safe branch-name helpers. Kept free of Node built-ins (no
 * `node:crypto`) so client surfaces — the New Session dialog and the spawn
 * card — can derive the same live branch preview the server uses, without
 * pulling the session repo (and `better-sqlite3` / `node:crypto`) into the
 * browser bundle.
 */

/** Sanitize a session name into a valid git branch suffix. */
export function sanitizeBranchName(sessionName: string): string {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
