import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { _createTestDb } from "./state-db";
import { createConversationsRepo } from "./conversations-repo";
import { createProjectConversationsRepo } from "./project-conversations-repo";
import {
  conversationStateSchema,
  type ConversationState,
} from "@/lib/conversations/schemas";

type Db = InstanceType<typeof Database>;

const ts = "2025-01-01T00:00:00.000Z";

function sessionConversation(id: string): ConversationState {
  return conversationStateSchema.parse({
    id,
    transcriptPath: null,
    status: "awaiting",
    promptCount: 2,
    createdAt: ts,
    lastActivityAt: ts,
    agentBackend: "claude",
  });
}

/**
 * Regression: the schema/persistence generalization must leave the
 * session-conversation arm byte-for-byte unchanged, and the two arms must not
 * bleed into each other.
 */
describe("session conversation regression", () => {
  let db: Db;

  beforeEach(() => {
    db = _createTestDb({ inMemory: true });
    db.prepare(`INSERT INTO projects (root_path) VALUES ('/repo')`).run();
    db.prepare(
      `INSERT INTO sessions
         (project_path, session_name, worktree_path, branch_name, created_at, last_activity_at)
       VALUES ('/repo', 'feat', '/repo/.worktrees/feat', 'csm/feat', ?, ?)`,
    ).run(ts, ts);
  });

  afterEach(() => {
    db.close();
  });

  it("persists and reads a session conversation with scope defaulting to session", () => {
    const repo = createConversationsRepo(db);
    repo.upsert("/repo", "feat", sessionConversation("s1"));

    const found = repo.findByKey("/repo", "feat", "s1");
    expect(found?.scope).toBe("session");
    expect(found?.id).toBe("s1");
    expect(found?.promptCount).toBe(2);
    expect(found?.agentBackend).toBe("claude");
    // The session conversation is invisible to the project-conversation arm.
    const projectRepo = createProjectConversationsRepo(db);
    expect(projectRepo.findAll()).toHaveLength(0);
    expect(projectRepo.findById("s1")).toBeNull();
  });

  it("keeps the session conversations table independent of project_conversations", () => {
    const repo = createConversationsRepo(db);
    repo.upsert("/repo", "feat", sessionConversation("s1"));

    const sessionRows = db
      .prepare(`SELECT COUNT(*) AS n FROM conversations`)
      .get() as { n: number };
    const projectRows = db
      .prepare(`SELECT COUNT(*) AS n FROM project_conversations`)
      .get() as { n: number };
    expect(sessionRows.n).toBe(1);
    expect(projectRows.n).toBe(0);
  });
});
