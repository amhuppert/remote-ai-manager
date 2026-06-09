/**
 * Real-store-backed persistence fixture for the conversation load/mutate seam.
 *
 * Each `createPersistenceFixture()` owns an isolated `:memory:` SQLite database
 * opened from the production DDL, a real `createStateStore` composed over it,
 * and the real repositories used for FK-parent seeding. The exposed `deps`
 * (`mutateConversation`/`getConversation`) are the production store's own
 * methods, so consumer tests can inject `fixture.deps` in place of the real
 * conversation seam with zero signature changes and exercise a genuine
 * serialization round-trip.
 *
 * Test-only: never touches the shared application store singleton.
 */

import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import type { ConversationState } from "@/lib/conversations/schemas";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import type { ConversationsRepo } from "@/lib/state-store/conversations-repo";
import type { ProjectsRepo } from "@/lib/state-store/projects-repo";
import type { SessionsRepo } from "@/lib/state-store/sessions-repo";
import type { Db } from "@/lib/state-store/schemas";
import { _createTestDb, truncateAllTables } from "@/lib/state-store/state-db";
import { createStateStore, type StateStore } from "@/lib/state-store/store";
import { createWriteQueue } from "@/lib/state-store/write-queue";

/**
 * The conversation load/mutate seam consumers inject today (setter-style via
 * `setPersistenceDeps`, or as a `deps` parameter object). Method syntax for
 * bivariance, mirroring the real store's signatures.
 */
export interface ConversationSeamDeps {
  mutateConversation<T = void>(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    label: string,
    mutate: (conversation: ConversationState) => T | Promise<T>,
  ): Promise<T>;
  getConversation(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationState | null>;
}

export interface PersistenceFixture {
  readonly db: Db;
  readonly store: StateStore;
  readonly deps: ConversationSeamDeps;
  seedProject(rootPath: string): void;
  seedSession(projectPath: string, sessionName: string): void;
  seedConversation(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
  ): Promise<void>;
  reset(): void;
  close(): void;
}

function buildSeedSession(projectPath: string, sessionName: string) {
  return sessionStateSchema.parse({
    sessionName,
    worktreePath: `${projectPath}/.worktrees/${sessionName}`,
    branchName: `csm/${sessionName}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
  });
}

export function createPersistenceFixture(): PersistenceFixture {
  const db = _createTestDb({ inMemory: true });
  const writeQueue = createWriteQueue();
  const repos = {
    projects: createProjectsRepo(db),
    sessions: createSessionsRepo(db),
    conversations: createConversationsRepo(db),
  } satisfies {
    projects: ProjectsRepo;
    sessions: SessionsRepo;
    conversations: ConversationsRepo;
  };

  const store = createStateStore({ db, writeQueue, repos });

  const deps: ConversationSeamDeps = {
    mutateConversation: store.mutateConversation,
    getConversation: store.getConversation,
  };

  return {
    db,
    store,
    deps,
    seedProject(rootPath) {
      repos.projects.upsert({ rootPath });
    },
    seedSession(projectPath, sessionName) {
      repos.sessions.upsert(
        projectPath,
        buildSeedSession(projectPath, sessionName),
      );
    },
    async seedConversation(projectPath, sessionName, conversation) {
      const validated = conversationStateSchema.parse(conversation);
      repos.conversations.upsert(projectPath, sessionName, validated);
    },
    reset() {
      truncateAllTables(db);
    },
    close() {
      db.close();
    },
  };
}
