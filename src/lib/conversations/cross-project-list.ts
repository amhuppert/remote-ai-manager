/**
 * Cross-project conversation enumeration for the `#`-trigger autocomplete.
 *
 * Walks the manager state — projects → sessions → conversations — plus the
 * project-scoped conversation repo, and emits one `ConversationListItem` per
 * conversation. When a conversation has no name and no summary, falls back to
 * reading the first user turn from the transcript to give the autocomplete a
 * meaningful label.
 */

import path from "node:path";
import {
  getArchivedProjects as defaultGetArchivedProjects,
  getConversationById as defaultGetConversationById,
  getProjectConversationById as defaultGetProjectConversationById,
  listAllProjectConversations as defaultListAllProjectConversations,
  listSessionConversationListItems as defaultListSessionConversationListItems,
  getStateDb,
  type SessionConversationListItem,
} from "@/lib/state-store";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { readTranscriptEntriesWithSeq } from "@/lib/prompt/transcript";
import { getFirstPromptSnippet as defaultGetFirstPromptSnippet } from "./first-prompt-snippet";
import { createLogger } from "@/lib/logging";
import { isProjectSentinel } from "./project-conversation-scope";
import { redactedConversationProfile } from "./conversation-profile";
import type { RedactedAgentProfileSnapshot } from "@/lib/agent-profiles/schemas";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";
import type { ConversationListItem, ConversationState } from "./schemas";

/**
 * The conversation fields {@link buildConversationListItem} reads. Satisfied by
 * both a full `ConversationState` (the by-id lookup path) and the store's
 * list-item projection (the cross-project walk), so the builder serves both
 * without pulling a conversation's full state.
 */
type ConversationListItemSource = Pick<
  ConversationState,
  | "id"
  | "name"
  | "summary"
  | "agentBackend"
  | "backendRef"
  | "transcriptPath"
  | "debugMode"
  | "status"
  | "lastActivityAt"
  | "archived"
> & {
  /**
   * Already redacted at the source (R6.3). The store's list-item projection
   * extracts it in SQL; the project-conversation walk, which holds a full row,
   * redacts at the call site. Either way the builder never sees a snapshot it
   * could forward whole.
   */
  redactedProfileSnapshot: RedactedAgentProfileSnapshot | null;
};

const log = createLogger("conversations:cross-project-list");

const MAX_SNIPPET_CONCURRENCY = 16;

export interface ListAllConversationsOptions {
  includeArchived: boolean;
}

export interface ListAllConversationsResult {
  items: ConversationListItem[];
  totalCount: number;
}

export interface ListAllConversationsDeps {
  listSessionConversationListItems(): Promise<SessionConversationListItem[]>;
  getArchivedProjects(): Promise<Set<string>>;
  listAllProjectConversations(): Promise<
    { projectPath: string; conversation: ConversationState }[]
  >;
  getFirstPromptSnippet(transcriptPath: string): Promise<string | null>;
  findArtifactsByConversationIds(
    conversationIds: string[],
  ): ContextArtifactRow[];
  readTranscriptEntries(
    transcriptPath: string,
  ): Promise<TranscriptEntriesResult>;
}

const defaultDeps: ListAllConversationsDeps = {
  listSessionConversationListItems: defaultListSessionConversationListItems,
  getArchivedProjects: defaultGetArchivedProjects,
  listAllProjectConversations: defaultListAllProjectConversations,
  getFirstPromptSnippet: defaultGetFirstPromptSnippet,
  findArtifactsByConversationIds: (conversationIds) =>
    createContextArtifactsRepo(getStateDb()).findByConversationIds(
      conversationIds,
    ),
  readTranscriptEntries: readTranscriptEntriesWithSeq,
};

/**
 * The listed conversation's scope. A project conversation is emitted as the
 * project variant — it has no `sessionName` field, so the internal sentinel it is
 * keyed by in the state store cannot reach this public payload (R1.3).
 */
type ListItemScope =
  | { scope: "session"; sessionName: string }
  | { scope: "project" };

/**
 * Adapt a whole conversation row to the list-item source. The store's list
 * projection already arrives redacted; the paths that hold a full row (the
 * project-conversation walk, the by-id lookups) redact here, so the builder
 * below is never handed a snapshot it could forward.
 */
function listItemSourceOf(
  conversation: ConversationState,
): ConversationListItemSource {
  return {
    ...conversation,
    redactedProfileSnapshot: redactedConversationProfile(conversation),
  };
}

/**
 * Lift a STORE session key into the public list scope (the A5 adapter boundary):
 * a sentinel-keyed row is a project conversation and is listed as one. Used where
 * the session name arrives from a store row rather than from iterating real
 * sessions, so a sentinel can never be projected as a session name.
 */
function listItemScopeFromStoreSessionName(sessionName: string): ListItemScope {
  return isProjectSentinel(sessionName)
    ? { scope: "project" }
    : { scope: "session", sessionName };
}

function buildConversationListItem(
  projectPath: string,
  scope: ListItemScope,
  worktreePath: string,
  convo: ConversationListItemSource,
): ConversationListItem {
  return {
    ...scope,
    projectName: path.basename(projectPath) || projectPath,
    projectPath,
    worktreePath,
    conversationId: convo.id,
    conversationName: convo.name,
    summary: convo.summary,
    firstPromptSnippet: null,
    backend: convo.agentBackend,
    backendRef: convo.backendRef,
    transcriptPath: convo.transcriptPath,
    debugLogPath: convo.debugMode?.logFilePath ?? null,
    status: convo.status,
    lastActivityAt: convo.lastActivityAt,
    archived: convo.archived,
    redactedProfileSnapshot: convo.redactedProfileSnapshot,
  };
}

function needsSnippet(
  convo: Pick<
    ConversationListItemSource,
    "name" | "summary" | "transcriptPath"
  >,
): boolean {
  return (
    convo.name === null &&
    convo.summary === null &&
    convo.transcriptPath !== null
  );
}

export function createListAllConversations(deps: ListAllConversationsDeps) {
  return async function listAllConversations(
    options: ListAllConversationsOptions,
  ): Promise<ListAllConversationsResult> {
    const [sessionItems, archivedProjects] = await Promise.all([
      deps.listSessionConversationListItems(),
      deps.getArchivedProjects(),
    ]);

    interface Pending {
      itemIndex: number;
      transcriptPath: string;
    }
    const items: ConversationListItem[] = [];
    const pending: Pending[] = [];

    const countedProjects = new Set<string>();
    let conversationCount = 0;
    let projectConversationCount = 0;

    const pushItem = (
      projectPath: string,
      scope: ListItemScope,
      worktreePath: string,
      convo: ConversationListItemSource,
    ) => {
      const itemIndex = items.length;
      items.push(
        buildConversationListItem(projectPath, scope, worktreePath, convo),
      );

      if (needsSnippet(convo) && convo.transcriptPath !== null) {
        pending.push({ itemIndex, transcriptPath: convo.transcriptPath });
      }
    };

    for (const { projectPath, session, conversations } of sessionItems) {
      if (!options.includeArchived && archivedProjects.has(projectPath))
        continue;
      countedProjects.add(projectPath);

      if (!options.includeArchived && session.archived) continue;

      for (const convo of conversations) {
        if (!options.includeArchived && convo.archived) continue;
        conversationCount += 1;
        pushItem(
          projectPath,
          { scope: "session", sessionName: session.sessionName },
          session.worktreePath,
          convo,
        );
      }
    }
    const projectCount = countedProjects.size;

    // Project-scoped conversations live in their own repo (not on any session)
    // and execute at the project root. The sentinel they are keyed by internally
    // stops here: they go on the wire as the project variant.
    const projectConversations = await deps.listAllProjectConversations();
    for (const { projectPath, conversation } of projectConversations) {
      if (!options.includeArchived && archivedProjects.has(projectPath))
        continue;
      if (!options.includeArchived && conversation.archived) continue;
      projectConversationCount += 1;
      pushItem(
        projectPath,
        { scope: "project" },
        projectPath,
        listItemSourceOf(conversation),
      );
    }

    log.info("listing conversations", {
      projectCount,
      conversationCount,
      projectConversationCount,
      includeArchived: options.includeArchived,
      snippetReads: pending.length,
    });

    await runWithConcurrency(pending, MAX_SNIPPET_CONCURRENCY, async (task) => {
      const snippet = await deps.getFirstPromptSnippet(task.transcriptPath);
      const target = items[task.itemIndex];
      if (target) target.firstPromptSnippet = snippet;
    });

    const enrichStart = Date.now();
    const compaction = await enrichWithCompactionStatus(items, deps);
    if (compaction.compactedConversations > 0) {
      log.info("compaction enrichment", {
        ...compaction,
        ms: Date.now() - enrichStart,
      });
    }

    return { items, totalCount: items.length };
  };
}

interface CompactionEnrichmentStats {
  artifactRows: number;
  compactedConversations: number;
  transcriptReads: number;
}

/**
 * Advertise completed conversation-compaction artifacts on list items
 * (design §12.4): one batched artifact query, then fresh/stale derived from
 * the entry reader's maxSeq vs the artifact's covered range — one (cached)
 * stat per compacted conversation, zero I/O for the rest.
 */
async function enrichWithCompactionStatus(
  items: ConversationListItem[],
  deps: Pick<
    ListAllConversationsDeps,
    "findArtifactsByConversationIds" | "readTranscriptEntries"
  >,
): Promise<CompactionEnrichmentStats> {
  const none: CompactionEnrichmentStats = {
    artifactRows: 0,
    compactedConversations: 0,
    transcriptReads: 0,
  };
  if (items.length === 0) return none;

  const rows = deps.findArtifactsByConversationIds(
    items.map((i) => i.conversationId),
  );
  if (rows.length === 0) return none;

  const byConversation = new Map<string, ContextArtifactRow>();
  for (const row of rows) {
    if (row.kind === "conversation_compaction" && row.status === "complete") {
      byConversation.set(row.conversationId, row);
    }
  }

  interface StalenessTask {
    item: ConversationListItem;
    row: ContextArtifactRow;
    transcriptPath: string;
  }
  const tasks: StalenessTask[] = [];
  for (const item of items) {
    const row = byConversation.get(item.conversationId);
    if (!row) continue;
    item.compactArtifactId = row.id;
    item.compactCoveredSeq = `${row.coveredStartSeq}..${row.coveredEndSeq}`;
    item.compactCreatedAt = row.createdAt;
    if (item.transcriptPath === null) {
      item.compactStatus = "fresh";
      continue;
    }
    tasks.push({ item, row, transcriptPath: item.transcriptPath });
  }

  await runWithConcurrency(tasks, MAX_SNIPPET_CONCURRENCY, async (task) => {
    try {
      const { maxSeq } = await deps.readTranscriptEntries(task.transcriptPath);
      task.item.compactStatus =
        maxSeq > task.row.coveredEndSeq ? "stale" : "fresh";
    } catch (err) {
      // Unknown transcript position — advertise conservatively as stale.
      task.item.compactStatus = "stale";
      log.warn("compaction staleness read failed", {
        conversationId: task.item.conversationId,
        err: String(err),
      });
    }
  });

  return {
    artifactRows: rows.length,
    compactedConversations: byConversation.size,
    transcriptReads: tasks.length,
  };
}

async function runWithConcurrency<T>(
  tasks: readonly T[],
  limit: number,
  worker: (task: T) => Promise<void>,
): Promise<void> {
  if (tasks.length === 0) return;
  let cursor = 0;
  const runners: Promise<void>[] = [];
  const slots = Math.min(limit, tasks.length);
  for (let i = 0; i < slots; i++) {
    runners.push(
      (async () => {
        while (true) {
          const index = cursor++;
          if (index >= tasks.length) return;
          const task = tasks[index];
          if (task === undefined) return;
          try {
            await worker(task);
          } catch (err) {
            log.warn("snippet read failed", { err: String(err) });
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}

export const listAllConversations = createListAllConversations(defaultDeps);

export interface FindConversationByIdDeps {
  getConversationById(conversationId: string): Promise<{
    projectPath: string;
    sessionName: string;
    worktreePath: string;
    conversation: ConversationState;
  } | null>;
  /**
   * Project conversations live in their own table, so resolving an id alone
   * needs both lookups. Without this, `cctl conversation read <id>` on a
   * project conversation 404s and can never select the project route (R2.4).
   */
  getProjectConversationById(conversationId: string): Promise<{
    projectPath: string;
    conversation: ConversationState;
  } | null>;
  getFirstPromptSnippet(transcriptPath: string): Promise<string | null>;
}

const defaultFindDeps: FindConversationByIdDeps = {
  getConversationById: defaultGetConversationById,
  getProjectConversationById: defaultGetProjectConversationById,
  getFirstPromptSnippet: defaultGetFirstPromptSnippet,
};

/**
 * Resolve a conversation of EITHER scope by id alone, via the focused
 * state-store accessors (no whole-state scan). Archived conversations stay
 * resolvable — deep links to archived conversations must render. A project
 * conversation is returned as the project variant, with no `sessionName` for
 * the sentinel to occupy.
 */
export function createFindConversationById(deps: FindConversationByIdDeps) {
  return async function findConversationById(
    conversationId: string,
  ): Promise<ConversationListItem | null> {
    const found = await deps.getConversationById(conversationId);
    if (!found) {
      const project = await deps.getProjectConversationById(conversationId);
      if (!project) return null;
      // A project conversation executes in the project root; it has no worktree.
      return withSnippet(
        deps,
        buildConversationListItem(
          project.projectPath,
          { scope: "project" },
          project.projectPath,
          listItemSourceOf(project.conversation),
        ),
        conversationId,
      );
    }

    return withSnippet(
      deps,
      buildConversationListItem(
        found.projectPath,
        listItemScopeFromStoreSessionName(found.sessionName),
        found.worktreePath,
        listItemSourceOf(found.conversation),
      ),
      conversationId,
    );
  };
}

/** Fill the first-prompt snippet for an unnamed conversation. Scope-invariant. */
async function withSnippet(
  deps: Pick<FindConversationByIdDeps, "getFirstPromptSnippet">,
  item: ConversationListItem,
  conversationId: string,
): Promise<ConversationListItem> {
  if (item.conversationName !== null || item.summary !== null) return item;
  if (item.transcriptPath === null) return item;
  try {
    item.firstPromptSnippet = await deps.getFirstPromptSnippet(
      item.transcriptPath,
    );
  } catch (err) {
    log.warn("snippet read failed", { conversationId, err: String(err) });
  }
  return item;
}

export const findConversationById = createFindConversationById(defaultFindDeps);
