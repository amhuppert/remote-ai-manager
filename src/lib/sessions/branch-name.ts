/**
 * Pure, client-safe branch-name helpers. Kept free of Node built-ins (no
 * `node:crypto`) so client surfaces — the New Session dialog and the spawn
 * card — can derive the same live branch preview the server uses, without
 * pulling the session repo (and `better-sqlite3` / `node:crypto`) into the
 * browser bundle.
 */

/**
 * A leading Jira ticket key in an already-lowercased slug. The number must end
 * at a hyphen or the end of the slug so names like `fix-2fa-login` stay as-is.
 */
const LEADING_TICKET_KEY = /^[a-z]{2,}-\d+(?=-|$)/;

/**
 * Sanitize a session name into a valid git branch suffix. A leading Jira
 * ticket key keeps Jira's uppercase form (`TRACK-123-fix-some-bug`) so the
 * branch links to its issue.
 */
export function sanitizeBranchName(sessionName: string): string {
  return sessionName
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .replace(LEADING_TICKET_KEY, (key) => key.toUpperCase());
}
