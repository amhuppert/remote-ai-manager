/**
 * Test-only whole-state seed/read helpers.
 *
 * The production whole-state surface (`readState`/`mutateState`/`writeState` and
 * the aggregate's `readAll`/`diffAndCommit`) was deleted in the focused-first
 * completion (Design 2.3): nothing on a hot path may pay O(total-state) anymore.
 * A handful of pre-existing tests still find it convenient to seed or inspect an
 * entire `ManagerState` at once. These helpers give them that convenience
 * WITHOUT reintroducing the production surface: they operate over a raw `Db`
 * using fresh repos, so they are reachable only from test code that already has
 * the database handle — never from a domain module through the store.
 *
 * `readWholeStateForTest` constructs fresh repos on every call, so it always
 * reflects the database rather than any store instance's warmed cache.
 */

import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { createConversationsRepo } from "@/lib/state-store/conversations-repo";
import { createProjectsRepo } from "@/lib/state-store/projects-repo";
import { createReferenceDocumentsRepo } from "@/lib/state-store/reference-documents-repo";
import { createSessionsRepo } from "@/lib/state-store/sessions-repo";
import type { Db } from "@/lib/state-store/schemas";

/**
 * Upsert an entire `ManagerState` into the database via fresh repos: every
 * project (with its overrides and archived/pinned membership), session,
 * conversation, and reference document. Additive — it does not remove rows
 * absent from `state`; seed into a fresh (or truncated) database.
 */
export function seedWholeState(db: Db, state: ManagerState): void {
  const projects = createProjectsRepo(db);
  const sessions = createSessionsRepo(db);
  const conversations = createConversationsRepo(db);
  const referenceDocuments = createReferenceDocumentsRepo(db);

  const archived = new Set(state.archivedProjects);
  const pinnedOrder = new Map(state.pinnedProjects.map((p, i) => [p, i]));

  const txn = db.transaction(() => {
    for (const [rootPath, project] of Object.entries(state.projects)) {
      projects.upsert({
        rootPath,
        ...(project.mcpOverrides !== undefined && {
          mcpOverrides: project.mcpOverrides,
        }),
        ...(project.agentCapabilityOverrides !== undefined && {
          agentCapabilityOverrides: project.agentCapabilityOverrides,
        }),
      });
      if (archived.has(rootPath)) projects.setArchived(rootPath, true);
      if (pinnedOrder.has(rootPath)) projects.setPinned(rootPath, true);

      for (const [sessionName, session] of Object.entries(project.sessions)) {
        sessions.upsert(rootPath, session);
        for (const conversation of session.conversations) {
          conversations.upsert(rootPath, sessionName, conversation);
        }
        for (const doc of session.referenceDocuments) {
          referenceDocuments.upsert(rootPath, sessionName, doc);
        }
      }
    }
    if (state.pinnedProjects.length > 0) {
      projects.reorderPinned([...state.pinnedProjects]);
    }
  });
  txn.immediate();
}

/**
 * Read the entire persisted `ManagerState` back from the database via fresh
 * repos. Mirrors the retired aggregate `readAll`, but as a test utility: fresh
 * repos mean it never serves a stale cache and never touches the store.
 */
export function readWholeStateForTest(db: Db): ManagerState {
  const projectsRepo = createProjectsRepo(db);
  const sessionsRepo = createSessionsRepo(db);
  const conversationsRepo = createConversationsRepo(db);
  const referenceDocumentsRepo = createReferenceDocumentsRepo(db);

  const sessionsByProject = new Map<string, Map<string, SessionState>>();
  for (const { projectPath, session } of sessionsRepo.findAll()) {
    let inner = sessionsByProject.get(projectPath);
    if (!inner) {
      inner = new Map<string, SessionState>();
      sessionsByProject.set(projectPath, inner);
    }
    inner.set(session.sessionName, session);
  }

  const convsBySession = new Map<string, Map<string, ConversationState[]>>();
  for (const {
    projectPath,
    sessionName,
    conversation,
  } of conversationsRepo.findAll()) {
    let bySession = convsBySession.get(projectPath);
    if (!bySession) {
      bySession = new Map<string, ConversationState[]>();
      convsBySession.set(projectPath, bySession);
    }
    const arr = bySession.get(sessionName);
    if (arr) arr.push(conversation);
    else bySession.set(sessionName, [conversation]);
  }

  const refsBySession = new Map<string, Map<string, ReferenceDocument[]>>();
  for (const {
    projectPath,
    sessionName,
    doc,
  } of referenceDocumentsRepo.findAll()) {
    let bySession = refsBySession.get(projectPath);
    if (!bySession) {
      bySession = new Map<string, ReferenceDocument[]>();
      refsBySession.set(projectPath, bySession);
    }
    const arr = bySession.get(sessionName);
    if (arr) arr.push(doc);
    else bySession.set(sessionName, [doc]);
  }

  const projects: Record<string, ProjectState> = {};
  const archivedProjects: string[] = [];
  const pinnedRaw: { rootPath: string; pinOrder: number | null }[] = [];

  for (const row of projectsRepo.listAll()) {
    if (row.archived) archivedProjects.push(row.rootPath);
    if (row.pinned) {
      pinnedRaw.push({ rootPath: row.rootPath, pinOrder: row.pinOrder });
    }

    const sessionMap =
      sessionsByProject.get(row.rootPath) ?? new Map<string, SessionState>();
    const sessionsRecord: Record<string, SessionState> = {};
    for (const [name, session] of sessionMap) {
      sessionsRecord[name] = {
        ...session,
        conversations: convsBySession.get(row.rootPath)?.get(name) ?? [],
        referenceDocuments: refsBySession.get(row.rootPath)?.get(name) ?? [],
      };
    }

    const project: Record<string, unknown> = {
      rootPath: row.rootPath,
      sessions: sessionsRecord,
    };
    if (row.mcpOverrides !== undefined) project.mcpOverrides = row.mcpOverrides;
    if (row.agentCapabilityOverrides !== undefined) {
      project.agentCapabilityOverrides = row.agentCapabilityOverrides;
    }
    projects[row.rootPath] = project as unknown as ProjectState;
  }

  pinnedRaw.sort(
    (a, b) =>
      (a.pinOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.pinOrder ?? Number.MAX_SAFE_INTEGER),
  );

  return {
    projects,
    archivedProjects,
    pinnedProjects: pinnedRaw.map((p) => p.rootPath),
  };
}
