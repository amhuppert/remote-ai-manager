import type { ConversationState } from "@/lib/conversations/schemas";
import type { ManagerState, ProjectState } from "@/lib/projects/schemas";
import {
  createConversationsRepo,
  type ConversationsRepo,
} from "./conversations-repo";
import type { Db } from "./schemas";
import { createSessionsRepo, type SessionsRepo } from "./sessions-repo";
import { getDb } from "./state-db";

/**
 * The narrow repo surface the startup reader enumerates. Only the two `findAll`
 * enumerations rehydration's candidate list is built from — never the reference-
 * document repo (rehydration reads no reference documents) and never the
 * snapshot sidecar (each conversation's resume token is fetched on demand as its
 * runtime is restored).
 */
export interface StartupReaderRepos {
  sessions: Pick<SessionsRepo, "findAll">;
  conversations: Pick<ConversationsRepo, "findAll">;
}

/**
 * Whole-state read owned by the startup/rehydration path — the one honest
 * whole-state consumer left after the focused-first migration deleted the public
 * `readState`. Assembles the project → session → conversation tree that
 * `collectRehydrationCandidates` walks to decide which persisted conversations
 * resume.
 *
 * It enumerates sessions and conversations via the repos' column-projected
 * `findAll` (which never selects `machine_snapshot`, moved to the sidecar in
 * Design 1), so no snapshot blob rides the startup scan. Reference documents,
 * archived/pinned membership, and project overrides are intentionally omitted —
 * rehydration consumes none of them, so they stay `[]`/empty rather than paying
 * an enumeration the startup path never reads.
 *
 * Takes its repos as a parameter and is not exported through the state-store
 * index barrel, and is deliberately NOT a `StateStore` method: domain code
 * holding `getStateStore()` has no whole-tree read to reach. The startup path
 * composes it via `readAllForStartupFromDb` below; the lint gate in
 * `eslint.config.mjs` restricts importing this module to the startup allowlist.
 */
export function readAllForStartup(repos: StartupReaderRepos): ManagerState {
  // Group conversations by their (projectPath, sessionName) parent without a
  // composite string key: an outer map per project, inner per session.
  const convsByProjectSession = new Map<
    string,
    Map<string, ConversationState[]>
  >();
  for (const {
    projectPath,
    sessionName,
    conversation,
  } of repos.conversations.findAll()) {
    let bySession = convsByProjectSession.get(projectPath);
    if (!bySession) {
      bySession = new Map<string, ConversationState[]>();
      convsByProjectSession.set(projectPath, bySession);
    }
    const arr = bySession.get(sessionName);
    if (arr) arr.push(conversation);
    else bySession.set(sessionName, [conversation]);
  }

  const projects: Record<string, ProjectState> = {};
  for (const { projectPath, session } of repos.sessions.findAll()) {
    let project = projects[projectPath];
    if (!project) {
      project = { rootPath: projectPath, sessions: {} };
      projects[projectPath] = project;
    }
    project.sessions[session.sessionName] = {
      ...session,
      conversations:
        convsByProjectSession.get(projectPath)?.get(session.sessionName) ?? [],
      referenceDocuments: [],
    };
  }

  return { projects, archivedProjects: [], pinnedProjects: [] };
}

/**
 * Startup-owned composition of the whole-state read. Builds cold, one-shot
 * repos over the process SQLite connection and runs the enumeration once, at
 * boot, before the app serves mutations — so the fresh repos read the same
 * committed rows the singleton store would, with no cache-coherence concern
 * (the read is a single boot-time snapshot, then discarded).
 *
 * This is the ONLY assembly of a whole-tree read left in the tree. It is not a
 * `StateStore` method and not re-exported through the state-store index barrel:
 * `getStateStore()` exposes no whole-state read, so a domain module cannot reach
 * one through the store it already holds. Only the startup/rehydration path
 * imports this module, enforced by the `no-restricted-imports` startup-reader
 * gate in `eslint.config.mjs`. The `db` parameter defaults to the process
 * connection for production and is injected by the persistence-fixture startup
 * test.
 */
export function readAllForStartupFromDb(db: Db = getDb()): ManagerState {
  return readAllForStartup({
    sessions: createSessionsRepo(db),
    conversations: createConversationsRepo(db),
  });
}
