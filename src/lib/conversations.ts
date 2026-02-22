import crypto from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ConversationState, SessionState } from "@/types";
import { readState, writeState } from "./state";
import { createLogger } from "./logging";

const logger = createLogger("conversations");

// ============================================================
// Conversation CRUD
// ============================================================

/** Create a new empty conversation in a session and persist it */
export async function createConversation(
  projectPath: string,
  sessionName: string,
): Promise<ConversationState> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const now = new Date().toISOString();
  const conversation: ConversationState = {
    id: crypto.randomUUID(),
    name: null,
    claudeSessionId: null,
    transcriptPath: null,
    status: "ready",
    promptCount: 0,
    createdAt: now,
    lastActivityAt: now,
    source: "csm",
    summary: null,
    archived: false,
  };

  session.conversations.push(conversation);
  await writeState(state);

  logger.info("conversation.created", {
    projectPath,
    sessionName,
    conversationId: conversation.id,
  });

  return conversation;
}

/** Get a specific conversation by ID within a session */
export async function getConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
): Promise<ConversationState | null> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return null;

  const session = project.sessions[sessionName];
  if (!session) return null;

  return session.conversations.find((c) => c.id === conversationId) ?? null;
}

/** Get all conversations for a session, ordered by most recently active first */
export async function getSessionConversations(
  projectPath: string,
  sessionName: string,
): Promise<ConversationState[]> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return [];

  const session = project.sessions[sessionName];
  if (!session) return [];

  return [...session.conversations].sort(
    (a, b) =>
      new Date(b.lastActivityAt).getTime() -
      new Date(a.lastActivityAt).getTime(),
  );
}

/** Set a conversation's archived flag */
export async function setConversationArchived(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  archived: boolean,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(
      `Conversation "${conversationId}" not found in session "${sessionName}"`,
    );
  }

  conversation.archived = archived;
  await writeState(state);
}

/** Rename a conversation. Also syncs to Claude Code's sessions-index.json if possible. */
export async function renameConversation(
  projectPath: string,
  sessionName: string,
  conversationId: string,
  name: string,
): Promise<void> {
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) {
    throw new Error(`Project not found: ${projectPath}`);
  }

  const session = project.sessions[sessionName];
  if (!session) {
    throw new Error(`Session "${sessionName}" not found in project`);
  }

  const conversation = session.conversations.find(
    (c) => c.id === conversationId,
  );
  if (!conversation) {
    throw new Error(
      `Conversation "${conversationId}" not found in session "${sessionName}"`,
    );
  }

  conversation.name = name;
  await writeState(state);

  // Write rename back to Claude Code's sessions-index.json
  if (conversation.claudeSessionId) {
    await updateSessionsIndexSummary(
      session.worktreePath,
      conversation.claudeSessionId,
      name,
    );
  }
}

// ============================================================
// Derived Session-Level Helpers (pure functions)
// ============================================================

// Re-export pure derive functions from client-safe module
export {
  deriveSessionStatus,
  deriveSessionPromptCount,
  deriveSessionLastActivity,
} from "./session-derived";

// ============================================================
// Auto-Import: Discover Claude Code sessions from filesystem
// ============================================================

/** Shape of an entry in Claude Code's sessions-index.json */
interface SessionsIndexEntry {
  sessionId?: string;
  fullPath?: string;
  firstPrompt?: string;
  summary?: string;
  messageCount?: number;
  created?: string;
  modified?: string;
  gitBranch?: string;
  projectPath?: string;
}

/** Read and parse Claude Code's sessions-index.json, returning entries array */
async function readSessionsIndex(
  claudeProjectDir: string,
): Promise<SessionsIndexEntry[]> {
  const indexPath = path.join(claudeProjectDir, "sessions-index.json");
  try {
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as {
      version?: number;
      entries?: SessionsIndexEntry[];
    };
    return Array.isArray(index.entries) ? index.entries : [];
  } catch {
    return [];
  }
}

/** Metadata for a discovered Claude Code session */
interface DiscoveredSession {
  sessionId: string;
  transcriptPath: string;
  firstPrompt: string | null;
  summary: string | null;
  messageCount: number;
  created: string;
  modified: string;
  gitBranch: string | null;
  cwd: string | null;
}

/**
 * Encode a filesystem path to the Claude Code project directory naming convention.
 * Slashes become dashes, dots are removed, with a leading dash prefix.
 * e.g. `/home/user/project/.worktrees/name` → `-home-user-project--worktrees-name`
 */
export function encodeProjectPath(fsPath: string): string {
  return "-" + fsPath.slice(1).replace(/[/.]/g, "-");
}

/** Get the full path to the Claude Code project directory for a worktree */
function getClaudeProjectDir(worktreePath: string): string {
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodeProjectPath(worktreePath),
  );
}

/** Check if a discovered session matches the given CSM session by cwd or git branch */
function matchesSession(
  discovered: DiscoveredSession,
  session: SessionState,
): boolean {
  if (discovered.cwd && discovered.cwd === session.worktreePath) return true;
  if (discovered.gitBranch && discovered.gitBranch === session.branchName)
    return true;
  return false;
}

/**
 * Task 8.1: Discover Claude Code sessions by reading sessions-index.json.
 * Returns discovered sessions filtered by cwd/gitBranch match.
 */
async function discoverFromIndex(
  claudeProjectDir: string,
  session: SessionState,
): Promise<DiscoveredSession[]> {
  const entries = await readSessionsIndex(claudeProjectDir);
  if (entries.length === 0) return [];

  const results: DiscoveredSession[] = [];
  for (const entry of entries) {
    if (!entry.sessionId || !entry.fullPath) continue;

    const discovered: DiscoveredSession = {
      sessionId: entry.sessionId,
      transcriptPath: entry.fullPath,
      firstPrompt: entry.firstPrompt ?? null,
      summary: entry.summary ?? null,
      messageCount: entry.messageCount ?? 0,
      created: entry.created ?? new Date().toISOString(),
      modified: entry.modified ?? new Date().toISOString(),
      gitBranch: entry.gitBranch ?? null,
      cwd: entry.projectPath ?? null,
    };

    if (matchesSession(discovered, session)) {
      results.push(discovered);
    }
  }
  return results;
}

/**
 * Task 8.2: Fall back to JSONL transcript parsing when no sessions-index.json exists.
 * Reads the first 5 lines of each .jsonl file to extract session metadata.
 */
async function discoverFromJsonl(
  claudeProjectDir: string,
  session: SessionState,
): Promise<DiscoveredSession[]> {
  let files: string[];
  try {
    const entries = await readdir(claudeProjectDir);
    files = entries.filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }

  const results: DiscoveredSession[] = [];
  for (const file of files) {
    const filePath = path.join(claudeProjectDir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const lines = content.split("\n").slice(0, 5).filter(Boolean);

      let sessionId: string | null = null;
      let cwd: string | null = null;
      let gitBranch: string | null = null;
      let timestamp: string | null = null;
      let firstPrompt: string | null = null;

      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (typeof parsed["sessionId"] === "string" && !sessionId) {
          sessionId = parsed["sessionId"];
        }
        if (typeof parsed["cwd"] === "string" && !cwd) {
          cwd = parsed["cwd"];
        }
        if (typeof parsed["gitBranch"] === "string" && !gitBranch) {
          gitBranch = parsed["gitBranch"];
        }
        if (typeof parsed["timestamp"] === "string" && !timestamp) {
          timestamp = parsed["timestamp"];
        }
        if (parsed["type"] === "user" && !firstPrompt) {
          const msg = parsed["message"] as { content?: string } | undefined;
          if (msg?.content) {
            firstPrompt = msg.content.slice(0, 200);
          }
        }
      }

      if (!sessionId) continue;

      const discovered: DiscoveredSession = {
        sessionId,
        transcriptPath: filePath,
        firstPrompt,
        summary: null,
        messageCount: 0,
        created: timestamp ?? new Date().toISOString(),
        modified: timestamp ?? new Date().toISOString(),
        gitBranch,
        cwd,
      };

      if (matchesSession(discovered, session)) {
        results.push(discovered);
      }
    } catch {
      // Skip unreadable files
      continue;
    }
  }
  return results;
}

/**
 * Task 8.3: Discover and import untracked Claude Code sessions as Conversation records.
 * Reads sessions-index.json first, falls back to JSONL parsing.
 * Deduplicates against existing conversation claudeSessionId values.
 * Returns newly imported conversations.
 */
export async function discoverAndImportConversations(
  projectPath: string,
  session: SessionState,
): Promise<ConversationState[]> {
  const claudeProjectDir = getClaudeProjectDir(session.worktreePath);

  // Try index-based discovery first, fall back to JSONL
  let discovered = await discoverFromIndex(claudeProjectDir, session);
  if (discovered.length === 0) {
    discovered = await discoverFromJsonl(claudeProjectDir, session);
  }

  if (discovered.length === 0) return [];

  // Deduplicate: skip sessions already tracked by claudeSessionId
  const existingIds = new Set(
    session.conversations
      .map((c) => c.claudeSessionId)
      .filter((id): id is string => id !== null),
  );

  const newDiscoveries = discovered.filter(
    (d) => !existingIds.has(d.sessionId),
  );

  if (newDiscoveries.length === 0) return [];

  // Create Conversation records for new discoveries
  const imported: ConversationState[] = newDiscoveries.map((d) => ({
    id: crypto.randomUUID(),
    name: null,
    claudeSessionId: d.sessionId,
    transcriptPath: d.transcriptPath,
    status: "idle" as const,
    promptCount: d.messageCount,
    createdAt: d.created,
    lastActivityAt: d.modified,
    source: "imported" as const,
    summary: d.summary ?? d.firstPrompt?.slice(0, 100) ?? null,
    archived: false,
  }));

  // Persist atomically
  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return [];
  const sessionState = project.sessions[session.sessionName];
  if (!sessionState) return [];

  sessionState.conversations.push(...imported);
  await writeState(state);

  logger.info("conversations.imported", {
    projectPath,
    sessionName: session.sessionName,
    count: imported.length,
    sessionIds: imported.map((c) => c.claudeSessionId),
  });

  return imported;
}

// ============================================================
// Summary Sync: Pull auto-generated names from Claude Code
// ============================================================

/**
 * Sync conversation summaries from Claude Code's sessions-index.json.
 * Updates existing conversations that have a claudeSessionId but no summary.
 */
export async function syncConversationSummaries(
  projectPath: string,
  session: SessionState,
): Promise<void> {
  const claudeProjectDir = getClaudeProjectDir(session.worktreePath);
  const entries = await readSessionsIndex(claudeProjectDir);
  if (entries.length === 0) return;

  // Build lookup: Claude sessionId → summary
  const summaryMap = new Map<string, string>();
  for (const entry of entries) {
    if (entry.sessionId && entry.summary) {
      summaryMap.set(entry.sessionId, entry.summary);
    }
  }

  // Find conversations that need summary updates
  const needsUpdate = session.conversations.filter(
    (c) =>
      c.claudeSessionId !== null &&
      c.summary === null &&
      summaryMap.has(c.claudeSessionId),
  );

  if (needsUpdate.length === 0) return;

  const state = await readState();
  const project = state.projects[projectPath];
  if (!project) return;
  const sessionState = project.sessions[session.sessionName];
  if (!sessionState) return;

  let updated = 0;
  for (const convo of sessionState.conversations) {
    if (
      convo.claudeSessionId !== null &&
      convo.summary === null &&
      summaryMap.has(convo.claudeSessionId)
    ) {
      convo.summary = summaryMap.get(convo.claudeSessionId)!;
      updated++;
    }
  }

  if (updated > 0) {
    await writeState(state);
    logger.info("conversations.summaries_synced", {
      projectPath,
      sessionName: session.sessionName,
      count: updated,
    });
  }
}

// ============================================================
// Sessions-index.json write-back for rename sync
// ============================================================

/**
 * Update the summary field for a session entry in Claude Code's sessions-index.json.
 * This makes renames visible when using Claude Code directly.
 */
async function updateSessionsIndexSummary(
  worktreePath: string,
  claudeSessionId: string,
  summary: string,
): Promise<void> {
  const claudeProjectDir = getClaudeProjectDir(worktreePath);
  const indexPath = path.join(claudeProjectDir, "sessions-index.json");

  try {
    const raw = await readFile(indexPath, "utf-8");
    const index = JSON.parse(raw) as {
      version?: number;
      entries?: SessionsIndexEntry[];
    };

    if (!Array.isArray(index.entries)) return;

    const entry = index.entries.find((e) => e.sessionId === claudeSessionId);
    if (!entry) return;

    entry.summary = summary;
    await writeFile(indexPath, JSON.stringify(index, null, 4), "utf-8");
  } catch {
    // sessions-index.json missing or unwritable — skip silently
  }
}
