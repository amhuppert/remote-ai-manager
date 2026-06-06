import type Database from "better-sqlite3";
import { createLogger } from "@/lib/logging";
import type { ConversationState } from "@/lib/conversations/schemas";
import type { ReferenceDocument } from "@/lib/reference-documents/schemas";
import {
  managerStateSchema,
  type ManagerState,
  type ProjectState,
} from "@/lib/projects/schemas";
import { type SessionState } from "@/lib/sessions/schemas";
import { PersistenceError } from "../shared/errors";
import { type ProjectsRepo } from "./projects-repo";
import { type SessionsRepo, canonicalSessionRow } from "./sessions-repo";
import {
  type ConversationsRepo,
  canonicalConversationRow,
} from "./conversations-repo";
import {
  type ReferenceDocumentsRepo,
  canonicalReferenceDocumentRow,
} from "./reference-documents-repo";

type Db = InstanceType<typeof Database>;

const logger = createLogger("state-store.aggregate");

export interface AllRepos {
  db: Db;
  projects: ProjectsRepo;
  sessions: SessionsRepo;
  conversations: ConversationsRepo;
  referenceDocuments: ReferenceDocumentsRepo;
}

export interface StateAggregate {
  readAll(): ManagerState;
  diffAndCommit(snapshot: ManagerState, mutated: ManagerState): void;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + stableStringify(obj[k]));
  }
  return "{" + parts.join(",") + "}";
}

function sessionKey(projectPath: string, sessionName: string): string {
  return `${projectPath}\u0000${sessionName}`;
}

interface SessionEntry {
  projectPath: string;
  session: SessionState;
}
interface ConversationEntry {
  projectPath: string;
  sessionName: string;
  conv: ConversationState;
}
interface ReferenceDocEntry {
  projectPath: string;
  sessionName: string;
  doc: ReferenceDocument;
}

function indexSessions(state: ManagerState): Map<string, SessionEntry> {
  const out = new Map<string, SessionEntry>();
  for (const [pp, ps] of Object.entries(state.projects)) {
    for (const [sn, session] of Object.entries(ps.sessions)) {
      out.set(sessionKey(pp, sn), { projectPath: pp, session });
    }
  }
  return out;
}

function indexConversations(
  state: ManagerState,
): Map<string, ConversationEntry> {
  const out = new Map<string, ConversationEntry>();
  for (const [pp, ps] of Object.entries(state.projects)) {
    for (const [sn, session] of Object.entries(ps.sessions)) {
      for (const conv of session.conversations) {
        out.set(conv.id, { projectPath: pp, sessionName: sn, conv });
      }
    }
  }
  return out;
}

function indexReferenceDocs(
  state: ManagerState,
): Map<string, ReferenceDocEntry> {
  const out = new Map<string, ReferenceDocEntry>();
  for (const [pp, ps] of Object.entries(state.projects)) {
    for (const [sn, session] of Object.entries(ps.sessions)) {
      for (const doc of session.referenceDocuments) {
        out.set(doc.id, { projectPath: pp, sessionName: sn, doc });
      }
    }
  }
  return out;
}

export function createStateAggregate(repos: AllRepos): StateAggregate {
  const db = repos.db;
  function readAll(): ManagerState {
    const start = performance.now();

    const projectRows = repos.projects.listAll();
    const sessionRows = repos.sessions.findAll();
    const conversationRows = repos.conversations.findAll();
    const refDocRows = repos.referenceDocuments.findAll();

    const sessionsByProject = new Map<string, Map<string, SessionState>>();
    for (const { projectPath, session } of sessionRows) {
      let inner = sessionsByProject.get(projectPath);
      if (!inner) {
        inner = new Map<string, SessionState>();
        sessionsByProject.set(projectPath, inner);
      }
      inner.set(session.sessionName, session);
    }

    const convsBySession = new Map<string, ConversationState[]>();
    for (const { projectPath, sessionName, conversation } of conversationRows) {
      const key = sessionKey(projectPath, sessionName);
      const arr = convsBySession.get(key);
      if (arr) arr.push(conversation);
      else convsBySession.set(key, [conversation]);
    }

    const refDocsBySession = new Map<string, ReferenceDocument[]>();
    for (const { projectPath, sessionName, doc } of refDocRows) {
      const key = sessionKey(projectPath, sessionName);
      const arr = refDocsBySession.get(key);
      if (arr) arr.push(doc);
      else refDocsBySession.set(key, [doc]);
    }

    const projects: Record<string, ProjectState> = {};
    const archivedProjects: string[] = [];
    const pinnedProjectsRaw: { rootPath: string; pinOrder: number | null }[] =
      [];

    for (const row of projectRows) {
      if (row.archived) archivedProjects.push(row.rootPath);
      if (row.pinned) {
        pinnedProjectsRaw.push({
          rootPath: row.rootPath,
          pinOrder: row.pinOrder,
        });
      }

      const sessionMap =
        sessionsByProject.get(row.rootPath) ?? new Map<string, SessionState>();
      const sessionsRecord: Record<string, SessionState> = {};
      for (const [name, sess] of sessionMap) {
        const key = sessionKey(row.rootPath, name);
        const conversations = convsBySession.get(key) ?? [];
        const referenceDocuments = refDocsBySession.get(key) ?? [];
        sessionsRecord[name] = {
          ...sess,
          conversations,
          referenceDocuments,
        };
      }

      const project: Record<string, unknown> = {
        rootPath: row.rootPath,
        sessions: sessionsRecord,
      };
      if (row.mcpOverrides !== undefined) {
        project.mcpOverrides = row.mcpOverrides;
      }
      if (row.agentCapabilityOverrides !== undefined) {
        project.agentCapabilityOverrides = row.agentCapabilityOverrides;
      }
      projects[row.rootPath] = project as unknown as ProjectState;
    }

    pinnedProjectsRaw.sort((a, b) => {
      const ao = a.pinOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.pinOrder ?? Number.MAX_SAFE_INTEGER;
      return ao - bo;
    });
    const pinnedProjects = pinnedProjectsRaw.map((p) => p.rootPath);

    const candidate = { projects, archivedProjects, pinnedProjects };
    const result = managerStateSchema.safeParse(candidate);
    const totalMs = +(performance.now() - start).toFixed(3);

    if (!result.success) {
      logger.error("state-store.aggregate.merge_failure", {
        side: "schema",
        issues: result.error.issues,
      });
      throw new PersistenceError({
        kind: "validation",
        entity: "ManagerState",
        issues: result.error.issues,
      });
    }

    logger.info("state.read.timing", {
      accessor: "readState",
      totalMs,
    });
    return result.data;
  }

  function diffAndCommit(snapshot: ManagerState, mutated: ManagerState): void {
    if (process.env.NODE_ENV !== "production") {
      managerStateSchema.parse(mutated);
    }

    const start = performance.now();

    const ops: Array<() => void> = [];
    let dirtyEntityCount = 0;

    const snapProjectKeys = new Set(Object.keys(snapshot.projects));
    const mutProjectKeys = new Set(Object.keys(mutated.projects));
    const removedProjectSet = new Set<string>();
    for (const k of snapProjectKeys) {
      if (!mutProjectKeys.has(k)) removedProjectSet.add(k);
    }

    for (const k of removedProjectSet) {
      ops.push(() => repos.projects.delete(k));
      dirtyEntityCount += 1;
    }

    for (const k of mutProjectKeys) {
      const mutPs = mutated.projects[k];
      if (!mutPs) continue;
      const isNew = !snapProjectKeys.has(k);
      const snapPs = isNew ? undefined : snapshot.projects[k];

      if (isNew) {
        const archived = mutated.archivedProjects.includes(k);
        const pinned = mutated.pinnedProjects.includes(k);
        ops.push(() => {
          repos.projects.upsert({
            rootPath: k,
            ...(mutPs.mcpOverrides !== undefined && {
              mcpOverrides: mutPs.mcpOverrides,
            }),
            ...(mutPs.agentCapabilityOverrides !== undefined && {
              agentCapabilityOverrides: mutPs.agentCapabilityOverrides,
            }),
          });
          if (archived) repos.projects.setArchived(k, true);
          if (pinned) repos.projects.setPinned(k, true);
        });
        dirtyEntityCount += 1;
        continue;
      }

      const snapMcp = stableStringify(snapPs?.mcpOverrides ?? null);
      const mutMcp = stableStringify(mutPs.mcpOverrides ?? null);
      const snapCaps = stableStringify(
        snapPs?.agentCapabilityOverrides ?? null,
      );
      const mutCaps = stableStringify(mutPs.agentCapabilityOverrides ?? null);
      const snapArchived = snapshot.archivedProjects.includes(k);
      const mutArchived = mutated.archivedProjects.includes(k);
      const snapPinned = snapshot.pinnedProjects.includes(k);
      const mutPinned = mutated.pinnedProjects.includes(k);

      let projectDirty = false;
      if (snapMcp !== mutMcp || snapCaps !== mutCaps) {
        projectDirty = true;
        ops.push(() =>
          repos.projects.upsert({
            rootPath: k,
            ...(mutPs.mcpOverrides !== undefined && {
              mcpOverrides: mutPs.mcpOverrides,
            }),
            ...(mutPs.agentCapabilityOverrides !== undefined && {
              agentCapabilityOverrides: mutPs.agentCapabilityOverrides,
            }),
          }),
        );
      }
      if (snapArchived !== mutArchived) {
        projectDirty = true;
        ops.push(() => repos.projects.setArchived(k, mutArchived));
      }
      if (snapPinned !== mutPinned) {
        projectDirty = true;
        ops.push(() => repos.projects.setPinned(k, mutPinned));
      }
      if (projectDirty) dirtyEntityCount += 1;
    }

    const snapPinnedSerialized = stableStringify(snapshot.pinnedProjects);
    const mutPinnedSerialized = stableStringify(mutated.pinnedProjects);
    if (
      snapPinnedSerialized !== mutPinnedSerialized &&
      mutated.pinnedProjects.length > 0
    ) {
      ops.push(() => repos.projects.reorderPinned([...mutated.pinnedProjects]));
    }

    const snapSessions = indexSessions(snapshot);
    const mutSessions = indexSessions(mutated);
    const removedSessionKeys = new Set<string>();
    for (const [key, val] of snapSessions) {
      if (mutSessions.has(key)) continue;
      removedSessionKeys.add(key);
      if (removedProjectSet.has(val.projectPath)) continue;
      ops.push(() =>
        repos.sessions.delete(val.projectPath, val.session.sessionName),
      );
      dirtyEntityCount += 1;
    }
    for (const [key, val] of mutSessions) {
      const snap = snapSessions.get(key);
      const mutCanon = canonicalSessionRow(val.projectPath, val.session);
      const snapCanon = snap
        ? canonicalSessionRow(snap.projectPath, snap.session)
        : undefined;
      if (snapCanon === mutCanon) continue;
      ops.push(() => repos.sessions.upsert(val.projectPath, val.session));
      dirtyEntityCount += 1;
    }

    const snapConvs = indexConversations(snapshot);
    const mutConvs = indexConversations(mutated);
    for (const [id, val] of snapConvs) {
      if (mutConvs.has(id)) continue;
      const sk = sessionKey(val.projectPath, val.sessionName);
      if (removedSessionKeys.has(sk)) continue;
      if (removedProjectSet.has(val.projectPath)) continue;
      ops.push(() => repos.conversations.delete(id));
      dirtyEntityCount += 1;
    }
    for (const [id, val] of mutConvs) {
      const snap = snapConvs.get(id);
      const mutCanon = canonicalConversationRow(
        val.projectPath,
        val.sessionName,
        val.conv,
      );
      const snapCanon = snap
        ? canonicalConversationRow(
            snap.projectPath,
            snap.sessionName,
            snap.conv,
          )
        : undefined;
      if (snapCanon === mutCanon) continue;
      ops.push(() =>
        repos.conversations.upsert(val.projectPath, val.sessionName, val.conv),
      );
      dirtyEntityCount += 1;
    }

    const snapRefs = indexReferenceDocs(snapshot);
    const mutRefs = indexReferenceDocs(mutated);
    for (const [id, val] of snapRefs) {
      if (mutRefs.has(id)) continue;
      const sk = sessionKey(val.projectPath, val.sessionName);
      if (removedSessionKeys.has(sk)) continue;
      if (removedProjectSet.has(val.projectPath)) continue;
      ops.push(() => repos.referenceDocuments.delete(id));
      dirtyEntityCount += 1;
    }
    for (const [id, val] of mutRefs) {
      const snap = snapRefs.get(id);
      const mutCanon = canonicalReferenceDocumentRow(
        val.projectPath,
        val.sessionName,
        val.doc,
      );
      const snapCanon = snap
        ? canonicalReferenceDocumentRow(
            snap.projectPath,
            snap.sessionName,
            snap.doc,
          )
        : undefined;
      if (snapCanon === mutCanon) continue;
      ops.push(() =>
        repos.referenceDocuments.upsert(
          val.projectPath,
          val.sessionName,
          val.doc,
        ),
      );
      dirtyEntityCount += 1;
    }

    if (ops.length > 0) {
      const txn = db.transaction(() => {
        for (const op of ops) op();
      });
      txn.immediate();
    }

    const projectRowCount = mutProjectKeys.size;
    const sessionCount = mutSessions.size;
    const conversationCount = mutConvs.size;
    const referenceDocumentCount = mutRefs.size;
    const archivedProjectionMemberCount = mutated.archivedProjects.length;
    const pinnedProjectionMemberCount = mutated.pinnedProjects.length;
    const durationMs = +(performance.now() - start).toFixed(3);

    logger.info("state-store.aggregate.diff.timing", {
      durationMs,
      dirtyEntityCount,
      projectRowCount,
      sessionCount,
      conversationCount,
      referenceDocumentCount,
      archivedProjectionMemberCount,
      pinnedProjectionMemberCount,
    });
  }

  return { readAll, diffAndCommit };
}
