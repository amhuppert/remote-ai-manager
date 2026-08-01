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
import type { SessionState } from "@/lib/sessions/schemas";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createGraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import { createGraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import { createGraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import { createProjectConversationsRepo } from "@/lib/state-store/project-conversations-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import { createSpecsRepo } from "@/lib/state-store/specs-repo";
import type { ConversationsRepo } from "@/lib/state-store/conversations-repo";
import type { GraphWorkflowArchivedExecutionsRepo } from "@/lib/state-store/graph-workflow-archived-executions-repo";
import type { GraphWorkflowEventsRepo } from "@/lib/state-store/graph-workflow-events-repo";
import type { GraphWorkflowExecutionsRepo } from "@/lib/state-store/graph-workflow-executions-repo";
import type { ProjectsRepo } from "@/lib/state-store/projects-repo";
import type { SessionsRepo } from "@/lib/state-store/sessions-repo";
import type { SpecsRepo } from "@/lib/state-store/specs-repo";
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
  readonly graphWorkflowEvents: GraphWorkflowEventsRepo;
  /**
   * The ACTIVE graph-workflow execution repo. It keeps a parsed-row cache, so a
   * test proving durability rather than memory must read back through a second
   * `createGraphWorkflowExecutionsRepo(fixture.db)` — the post-restart reader.
   */
  readonly graphWorkflowExecutions: GraphWorkflowExecutionsRepo;
  readonly graphWorkflowArchivedExecutions: GraphWorkflowArchivedExecutionsRepo;
  readonly specs: SpecsRepo;
  seedProject(rootPath: string): void;
  seedSession(
    projectPath: string,
    sessionName: string,
    overrides?: Partial<SessionState>,
  ): void;
  seedConversation(
    projectPath: string,
    sessionName: string,
    conversation: ConversationState,
  ): Promise<void>;
  /**
   * Seed a project-scoped conversation — the session-less row the sentinel-aware
   * store path reads. Needed to prove behaviour that differs between the two
   * conversation scopes through the real repositories.
   */
  seedProjectConversation(
    projectPath: string,
    conversation: ConversationState,
  ): Promise<void>;
  /**
   * A brand-new `StateStore` over the SAME database — the state a restarted
   * server comes up with. Proving a recovery path needs this: reusing the
   * original store would leave whatever it holds in memory available to the
   * assertion, which is exactly what the recovery is supposed to survive
   * without.
   */
  recreateStore(): StateStore;
  reset(): void;
  close(): void;
}

function buildSeedSession(
  projectPath: string,
  sessionName: string,
  overrides: Partial<SessionState> = {},
) {
  return sessionStateSchema.parse({
    sessionName,
    worktreePath: `${projectPath}/.worktrees/${sessionName}`,
    branchName: `csm/${sessionName}`,
    createdAt: "2026-01-01T00:00:00Z",
    lastActivityAt: "2026-01-01T00:00:00Z",
    ...overrides,
  });
}

function buildStore(db: Db): StateStore {
  return createStateStore({
    db,
    writeQueue: createWriteQueue(),
    repos: {
      projects: createProjectsRepo(db),
      sessions: createSessionsRepo(db),
      conversations: createConversationsRepo(db),
      graphWorkflowEvents: createGraphWorkflowEventsRepo(db),
      graphWorkflowArchivedExecutions:
        createGraphWorkflowArchivedExecutionsRepo(db),
      projectConversations: createProjectConversationsRepo(db),
    },
  });
}

export function createPersistenceFixture(): PersistenceFixture {
  const db = _createTestDb({ inMemory: true });
  const writeQueue = createWriteQueue();
  const repos = {
    projects: createProjectsRepo(db),
    sessions: createSessionsRepo(db),
    conversations: createConversationsRepo(db),
    graphWorkflowEvents: createGraphWorkflowEventsRepo(db),
    graphWorkflowArchivedExecutions:
      createGraphWorkflowArchivedExecutionsRepo(db),
  } satisfies {
    projects: ProjectsRepo;
    sessions: SessionsRepo;
    conversations: ConversationsRepo;
    graphWorkflowEvents: GraphWorkflowEventsRepo;
    graphWorkflowArchivedExecutions: GraphWorkflowArchivedExecutionsRepo;
  };
  const specs = createSpecsRepo(db, writeQueue);
  const graphWorkflowExecutions = createGraphWorkflowExecutionsRepo(db);
  const projectConversations = createProjectConversationsRepo(db);

  const store = createStateStore({
    db,
    writeQueue,
    repos: { ...repos, projectConversations },
  });

  const deps: ConversationSeamDeps = {
    mutateConversation: store.mutateConversation,
    getConversation: store.getConversation,
  };

  return {
    db,
    store,
    deps,
    graphWorkflowEvents: repos.graphWorkflowEvents,
    graphWorkflowExecutions,
    graphWorkflowArchivedExecutions: repos.graphWorkflowArchivedExecutions,
    specs,
    seedProject(rootPath) {
      repos.projects.upsert({ rootPath });
    },
    seedSession(projectPath, sessionName, overrides) {
      repos.sessions.upsert(
        projectPath,
        buildSeedSession(projectPath, sessionName, overrides),
      );
    },
    async seedConversation(projectPath, sessionName, conversation) {
      const validated = conversationStateSchema.parse(conversation);
      repos.conversations.upsert(projectPath, sessionName, validated);
    },
    async seedProjectConversation(projectPath, conversation) {
      const validated = conversationStateSchema.parse(conversation);
      projectConversations.upsert(projectPath, validated);
    },
    recreateStore() {
      return buildStore(db);
    },
    reset() {
      truncateAllTables(db);
    },
    close() {
      db.close();
    },
  };
}
