import crypto from "node:crypto";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "@/lib/conversations/project-conversation-scope";
import { sanitizeBranchName } from "./branch-name";

/** Generate a 6-character random hex suffix for branch/worktree uniqueness */
export function generateRandomSuffix(): string {
  return crypto.randomBytes(3).toString("hex");
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

/** Validate session name: non-empty, reasonable length, must produce a valid branch suffix */
export function validateSessionName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return "Session name cannot be empty";
  }
  if (name.length > 100) {
    return "Session name must be 100 characters or less";
  }
  if (name === PROJECT_CONVERSATION_SESSION_SENTINEL) {
    return `"${PROJECT_CONVERSATION_SESSION_SENTINEL}" is reserved for project conversations and cannot be used as a session name`;
  }
  if (sanitizeBranchName(name).length === 0) {
    return "Session name must contain at least one letter or number";
  }
  return null;
}
