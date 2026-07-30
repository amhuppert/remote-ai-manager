/**
 * Test-only fixture: runs a REAL `CodexConversationRuntime` against a fake
 * provider whose thread resume rejects with the SDK's no-rollout message, and
 * returns the adapter's genuine stale-resume turn result. Lives inside the
 * backend seam (like `testfake-backend`) so integration tests above the seam
 * exercise the real adapter without deep-importing its internals. Never runs
 * in production.
 */

import { sessionConversationTarget } from "@/lib/conversations/conversation-target";
import type { AgentSessionRef } from "@/lib/shared/schemas";
import type { ConversationBackendTurnResult } from "../conversation";
import {
  CodexConversationRuntime,
  type CodexConversationRuntimeDeps,
  type CodexThreadLike,
} from "../codex/conversation-runtime";

export const STALE_CODEX_RESUME_REF: AgentSessionRef = {
  backend: "codex",
  ref: "thread-gone",
};

function makeStaleResumeDeps(): CodexConversationRuntimeDeps {
  const staleThread: CodexThreadLike = {
    id: STALE_CODEX_RESUME_REF.ref,
    async runStreamed() {
      throw new Error(
        `thread/resume: no rollout found for thread id "${STALE_CODEX_RESUME_REF.ref}"`,
      );
    },
  };
  return {
    createCodex: () => ({
      startThread: () => {
        throw new Error("stale resume must not fall back to startThread");
      },
      resumeThread: () => staleThread,
    }),
    buildChildEnv: () => ({ NODE_ENV: "test" }),
    toStringEnv: () => ({}),
    getServerUrl: () => null,
    getApiToken: () => null,
    getConfigDir: () => "/cfg",
    ensureManagedSkillsBridge: async () =>
      ({ status: "skipped", reason: "no_bundle" }) as const,
    translatePortableMcpToCodex: () => ({ mcpServers: {}, droppedFields: [] }),
    listNativeCodexMcpServers: async () => [],
    getCodexPricingOverrides: async () => null,
    now: () => 1000,
  };
}

export async function runStaleCodexResumeTurn(identity: {
  conversationId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
}): Promise<ConversationBackendTurnResult> {
  const runtime = new CodexConversationRuntime(
    {
      ...identity,
      conversationTarget: sessionConversationTarget(
        identity.projectName,
        identity.sessionName,
        identity.conversationId,
      ),
      persistedRef: STALE_CODEX_RESUME_REF,
      sessionInstructions: [],
      tooling: {},
    },
    makeStaleResumeDeps(),
  );
  return runtime.sendTurn({
    promptText: "Continue where we left off",
    imageRefs: [],
    sessionInstructions: [],
    autonomous: false,
    signal: new AbortController().signal,
    onEvent: () => {},
  });
}
