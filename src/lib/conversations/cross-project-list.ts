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
  readState as defaultReadState,
  getConversationById as defaultGetConversationById,
  listAllProjectConversations as defaultListAllProjectConversations,
  getStateDb,
} from "@/lib/state-store";
import { createContextArtifactsRepo } from "@/lib/context-artifacts/repo";
import { readTranscriptEntriesWithSeq } from "@/lib/prompt/transcript";
import { getFirstPromptSnippet as defaultGetFirstPromptSnippet } from "./first-prompt-snippet";
import { PROJECT_CONVERSATION_SESSION_SENTINEL } from "./project-conversation-scope";
import { createLogger } from "@/lib/logging";
import type { ContextArtifactRow } from "@/lib/context-artifacts/schemas";
import type { TranscriptEntriesResult } from "@/lib/prompt/transcript";
import type { ManagerState } from "@/lib/projects/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { ConversationListItem, ConversationState } from "./schemas";

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
  readState(): Promise<ManagerState>;
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
  readState: defaultReadState,
  listAllProjectConversations: defaultListAllProjectConversations,
  getFirstPromptSnippet: defaultGetFirstPromptSnippet,
  findArtifactsByConversationIds: (conversationIds) =>
    createContextArtifactsRepo(getStateDb()).findByConversationIds(
      conversationIds,
    ),
  readTranscriptEntries: readTranscriptEntriesWithSeq,
};

function buildConversationListItem(
  projectPath: string,
  session: Pick<SessionState, "sessionName" | "worktreePath">,
  convo: ConversationState,
): ConversationListItem {
  return {
    projectName: path.basename(projectPath) || projectPath,
    projectPath,
    sessionName: session.sessionName,
    worktreePath: session.worktreePath,
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
  };
}

function needsSnippet(convo: ConversationState): boolean {
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
    const state = await deps.readState();
    const archivedProjects = new Set(state.archivedProjects);

    interface Pending {
      itemIndex: number;
      transcriptPath: string;
    }
    const items: ConversationListItem[] = [];
    const pending: Pending[] = [];

    let projectCount = 0;
    let conversationCount = 0;
    let projectConversationCount = 0;

    const pushItem = (
      projectPath: string,
      session: Pick<SessionState, "sessionName" | "worktreePath">,
      convo: ConversationState,
    ) => {
      const itemIndex = items.length;
      items.push(buildConversationListItem(projectPath, session, convo));

      if (needsSnippet(convo) && convo.transcriptPath !== null) {
        pending.push({ itemIndex, transcriptPath: convo.transcriptPath });
      }
    };

    for (const [projectPath, project] of Object.entries(state.projects)) {
      if (!options.includeArchived && archivedProjects.has(projectPath))
        continue;
      projectCount += 1;

      for (const session of Object.values(project.sessions)) {
        if (!options.includeArchived && session.archived) continue;

        for (const convo of session.conversations) {
          if (!options.includeArchived && convo.archived) continue;
          conversationCount += 1;
          pushItem(projectPath, session, convo);
        }
      }
    }

    // Project-scoped conversations live in their own repo (not on any
    // session), execute at the project root, and are addressed through the
    // reserved sentinel session name.
    const projectConversations = await deps.listAllProjectConversations();
    for (const { projectPath, conversation } of projectConversations) {
      if (!options.includeArchived && archivedProjects.has(projectPath))
        continue;
      if (!options.includeArchived && conversation.archived) continue;
      projectConversationCount += 1;
      pushItem(
        projectPath,
        {
          sessionName: PROJECT_CONVERSATION_SESSION_SENTINEL,
          worktreePath: projectPath,
        },
        conversation,
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
  getFirstPromptSnippet(transcriptPath: string): Promise<string | null>;
}

const defaultFindDeps: FindConversationByIdDeps = {
  getConversationById: defaultGetConversationById,
  getFirstPromptSnippet: defaultGetFirstPromptSnippet,
};

/**
 * Resolve a single session-scoped conversation by id alone, via the focused
 * state-store accessor (no whole-state scan). Archived conversations stay
 * resolvable — deep links to archived conversations must render.
 * Project-scoped conversations live in a separate table and are never found.
 */
export function createFindConversationById(deps: FindConversationByIdDeps) {
  return async function findConversationById(
    conversationId: string,
  ): Promise<ConversationListItem | null> {
    const found = await deps.getConversationById(conversationId);
    if (!found) return null;

    const item = buildConversationListItem(
      found.projectPath,
      found,
      found.conversation,
    );
    if (needsSnippet(found.conversation) && item.transcriptPath !== null) {
      try {
        item.firstPromptSnippet = await deps.getFirstPromptSnippet(
          item.transcriptPath,
        );
      } catch (err) {
        log.warn("snippet read failed", {
          conversationId,
          err: String(err),
        });
      }
    }
    return item;
  };
}

export const findConversationById = createFindConversationById(defaultFindDeps);
