import { createLogger } from "@/lib/logging";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import { resolveProjectPath as defaultResolveProjectPath } from "@/lib/projects/resolver";
import {
  getSession as defaultGetSession,
  upsertSessionMarkdownDocuments as defaultUpsertSessionMarkdownDocuments,
} from "@/lib/state-store";
import type { MessageContentBlock } from "@/lib/conversations/message-content-schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import type { SessionMarkdownDocument } from "./schemas";
import { extractMarkdownFileRefs } from "./markdown-file-refs";
import { normalizeMarkdownLocator } from "./path";

const logger = createLogger("documents-index");

export interface SessionMarkdownIndexerInput {
  projectName: string;
  sessionName: string;
  seenAt: string;
  content: MessageContentBlock[];
}

export interface SessionMarkdownIndexerDeps {
  resolveProjectPath(projectName: string): Promise<string | null>;
  getSession(
    projectPath: string,
    sessionName: string,
  ): Promise<Pick<SessionState, "worktreePath"> | null>;
  upsertSessionMarkdownDocuments(
    projectPath: string,
    sessionName: string,
    documents: readonly SessionMarkdownDocument[],
  ): Promise<void>;
}

const defaultDeps: SessionMarkdownIndexerDeps = {
  resolveProjectPath: defaultResolveProjectPath,
  getSession: defaultGetSession,
  upsertSessionMarkdownDocuments: defaultUpsertSessionMarkdownDocuments,
};

export function createSessionMarkdownIndexer(
  deps: SessionMarkdownIndexerDeps = defaultDeps,
) {
  return async function indexSessionMarkdownDocuments(
    input: SessionMarkdownIndexerInput,
  ): Promise<void> {
    if (isProjectSentinel(input.sessionName)) return;

    const refs = extractMarkdownFileRefs(input.content);
    if (refs.length === 0) return;

    const projectPath = await deps.resolveProjectPath(input.projectName);
    if (!projectPath)
      throw new Error(`Project not found: ${input.projectName}`);
    const session = await deps.getSession(projectPath, input.sessionName);
    if (!session) throw new Error(`Session not found: ${input.sessionName}`);

    const documents: SessionMarkdownDocument[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const normalized = normalizeMarkdownLocator(
        ref.docPath,
        session.worktreePath,
      );
      if (!normalized.ok || seen.has(normalized.docPath)) continue;
      seen.add(normalized.docPath);
      documents.push({
        docPath: normalized.docPath,
        origin: ref.origin,
        firstSeenAt: input.seenAt,
        lastSeenAt: input.seenAt,
      });
    }
    if (documents.length === 0) return;

    const start = performance.now();
    await deps.upsertSessionMarkdownDocuments(
      projectPath,
      input.sessionName,
      documents,
    );
    logger.debug("documents-index.indexed", {
      projectName: input.projectName,
      sessionName: input.sessionName,
      documentCount: documents.length,
      durationMs: +(performance.now() - start).toFixed(3),
    });
  };
}

export const indexSessionMarkdownDocuments = createSessionMarkdownIndexer();
