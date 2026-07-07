/**
 * Production wiring for the help-context providers (docs/design/cc-cli/04 §4.3).
 *
 * Kept separate from `providers.ts` so the provider logic stays free of server
 * imports (and directly unit-testable). Everything here is read-only: it reuses
 * the existing dev-server, state-store, transcript, and context-artifact
 * primitives rather than reaching for a whole-state read (PERFORMANCE.md §1).
 */
import { NORMALIZER_VERSION } from "@/lib/conversations/transcript-render";
import { deriveFreshness } from "@/lib/context-artifacts/freshness";
import { PROMPT_VERSION } from "@/lib/context-artifacts/generation";
import {
  createContextArtifactsRepo,
  type ContextArtifactsRepo,
} from "@/lib/context-artifacts/repo";
import {
  CONTEXT_ARTIFACT_SCHEMA_VERSION,
  type ContextArtifactRow,
} from "@/lib/context-artifacts/schemas";
import { listDevServers } from "@/lib/dev-server/service";
import { resolveProjectPath } from "@/lib/projects/resolver";
import { readTranscriptEntriesWithSeq } from "@/lib/prompt/transcript";
import {
  getActiveGraphWorkflowExecution,
  getConversation,
  getProjectConversation,
} from "@/lib/state-store";
import { getStateDb } from "@/lib/state-store/store";

import type {
  ConversationArtifactSummary,
  HelpContextProviderDeps,
} from "./providers";

/**
 * Map artifact rows + the current transcript position to freshness summaries.
 * Pure — the I/O (transcript read, repo query) is done by the caller. Message
 * artifacts never rewrite their own lines (append-only), so only version drift
 * can date them; conversation artifacts go stale when the transcript advances
 * past their covered range (mirrors route-handlers.ts `freshnessFor`).
 */
export function summarizeArtifacts(
  rows: ContextArtifactRow[],
  maxSeq: number,
): ConversationArtifactSummary[] {
  const versions = {
    promptVersion: PROMPT_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
    schemaVersion: CONTEXT_ARTIFACT_SCHEMA_VERSION,
  };
  return rows.map((row) => {
    const freshness = deriveFreshness(row, { ...versions, maxSeq });
    const stale = row.kind === "message_compaction" ? false : freshness.stale;
    return { kind: row.kind, stale, outdated: freshness.outdated };
  });
}

// Lazy repo singleton: opens the shared SQLite handle only on first real use,
// never at import (route shells import this module at registration time).
let _repo: ContextArtifactsRepo | null = null;
function getRepo(): ContextArtifactsRepo {
  _repo ??= createContextArtifactsRepo(getStateDb());
  return _repo;
}

async function resolveTranscriptPath(input: {
  conversationId: string;
  project?: string;
  session?: string;
}): Promise<string | null> {
  if (!input.project) return null;
  const projectPath = await resolveProjectPath(input.project);
  if (!projectPath) return null;
  const conversation = input.session
    ? await getConversation(projectPath, input.session, input.conversationId)
    : await getProjectConversation(projectPath, input.conversationId);
  return conversation?.transcriptPath ?? null;
}

async function resolveConversationArtifacts(input: {
  conversationId: string;
  project?: string;
  session?: string;
}): Promise<ConversationArtifactSummary[]> {
  const rows = getRepo().findByConversation(input.conversationId);
  if (rows.length === 0) return [];

  // Only pay a transcript read once we know artifacts exist to place staleness on.
  const transcriptPath = await resolveTranscriptPath(input);
  const maxSeq =
    transcriptPath === null
      ? -1
      : (await readTranscriptEntriesWithSeq(transcriptPath)).maxSeq;
  return summarizeArtifacts(rows, maxSeq);
}

/** The production provider deps, wired to the live read accessors. */
export function createDefaultProviderDeps(): HelpContextProviderDeps {
  return {
    resolveProjectPath,
    listDevServers: (input) => listDevServers(input),
    getActiveGraphWorkflowExecution,
    resolveConversationArtifacts,
  };
}
