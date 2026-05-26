/**
 * Cross-project conversation enumeration for the `#`-trigger autocomplete.
 *
 * Walks the manager state — projects → sessions → conversations — and emits
 * one `ConversationListItem` per conversation. When a conversation has no
 * name and no summary, falls back to reading the first user turn from the
 * transcript to give the autocomplete a meaningful label.
 */

import path from "node:path";
import { readState as defaultReadState } from "@/lib/state-store";
import { getFirstPromptSnippet as defaultGetFirstPromptSnippet } from "./first-prompt-snippet";
import { createLogger } from "@/lib/logging";
import type { ManagerState } from "@/lib/projects/schemas";
import type { ConversationListItem } from "./schemas";

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
  getFirstPromptSnippet(transcriptPath: string): Promise<string | null>;
}

const defaultDeps: ListAllConversationsDeps = {
  readState: defaultReadState,
  getFirstPromptSnippet: defaultGetFirstPromptSnippet,
};

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

    for (const [projectPath, project] of Object.entries(state.projects)) {
      if (!options.includeArchived && archivedProjects.has(projectPath))
        continue;
      projectCount += 1;

      const projectName = path.basename(projectPath) || projectPath;

      for (const session of Object.values(project.sessions)) {
        if (!options.includeArchived && session.archived) continue;

        for (const convo of session.conversations) {
          if (!options.includeArchived && convo.archived) continue;
          conversationCount += 1;

          const item: ConversationListItem = {
            projectName,
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

          const itemIndex = items.length;
          items.push(item);

          if (
            convo.name === null &&
            convo.summary === null &&
            convo.transcriptPath !== null
          ) {
            pending.push({ itemIndex, transcriptPath: convo.transcriptPath });
          }
        }
      }
    }

    log.info("listing conversations", {
      projectCount,
      conversationCount,
      includeArchived: options.includeArchived,
      snippetReads: pending.length,
    });

    await runWithConcurrency(pending, MAX_SNIPPET_CONCURRENCY, async (task) => {
      const snippet = await deps.getFirstPromptSnippet(task.transcriptPath);
      const target = items[task.itemIndex];
      if (target) target.firstPromptSnippet = snippet;
    });

    return { items, totalCount: items.length };
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
